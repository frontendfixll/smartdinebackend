import mongoose, { ClientSession, Types } from 'mongoose';
import { getOrCreateRestaurant } from '@modules/restaurant/restaurant.service';
import { ReservationModel, ReservationStatus } from './reservation.model';
import { TableModel } from '@modules/tables/table.model';
import { TableSessionModel } from '@modules/tables/tableSession.model';
import { AuditLogModel } from '@modules/audit/auditLog.model';
import { AppError } from '@utils/AppError';
import { pacificDateTime } from '@utils/pacificDateTime';
import { validateReservationTransition } from './reservation.transitions';

export interface ActorCtx {
  actorId?: string;
  actorEmail?: string;
  actorRole?: string;
}
export const bookingFilter = { kind: { $ne: 'waitlist' }, notes: { $not: /^WAITLIST:/ } };
export const waitingFilter = { $or: [{ kind: 'waitlist' }, { notes: /^WAITLIST:/ }] };
export const isWaitlist = (r: { kind?: string; notes?: string }) =>
  r.kind === 'waitlist' || r.notes?.startsWith('WAITLIST:');
export function validateBookingTime(at: Date, duration: number) {
  if (!Number.isFinite(at.getTime()) || at <= new Date())
    throw AppError.badRequest('Choose a future reservation time');
  if (at.getTime() > Date.now() + 150 * 86400000)
    throw AppError.badRequest('Bookings can be requested up to 150 days ahead');
  if (!Number.isInteger(duration) || duration < 15 || duration > 360)
    throw AppError.badRequest('Duration must be 15–360 minutes');
}
async function checkHours(at: Date, duration: number) {
  const r = await getOrCreateRestaurant();
  if (!r.brand.openingHours.length)
    throw new AppError(
      'SERVICE_UNAVAILABLE',
      'Configure restaurant opening hours before confirming reservations',
    );
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  // Join adjacent opening intervals so continuous service can cross midnight.
  const windows: Array<{ start: number; end: number }> = [];
  for (const offset of [-1, 0, 1]) {
    const calendar = new Date(`${day}T12:00:00Z`);
    calendar.setUTCDate(calendar.getUTCDate() + offset);
    const hours = r.brand.openingHours.find((h) => h.dayOfWeek === calendar.getUTCDay());
    if (!hours || hours.isClosed) continue;
    const start = pacificDateTime(calendar.toISOString().slice(0, 10), hours.open).getTime();
    if (hours.close <= hours.open) calendar.setUTCDate(calendar.getUTCDate() + 1);
    const end = pacificDateTime(calendar.toISOString().slice(0, 10), hours.close).getTime();
    const last = windows[windows.length - 1];
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else windows.push({ start, end });
  }
  if (windows.some((w) => at.getTime() >= w.start && at.getTime() + duration * 60000 <= w.end))
    return;
  throw AppError.conflict('The full booking must fit within the restaurant opening hours');
}
export function overlapFilter(
  tableId: Types.ObjectId,
  at: Date,
  duration: number,
  exclude?: string,
) {
  return {
    tableId,
    ...(exclude ? { _id: { $ne: new Types.ObjectId(exclude) } } : {}),
    status: { $in: ['confirmed', 'checked_in'] },
    reservedAt: { $lt: new Date(at.getTime() + duration * 60000) },
    $expr: {
      $gt: [
        {
          $ifNull: [
            '$endsAt',
            {
              $add: ['$reservedAt', { $multiply: [{ $ifNull: ['$durationMinutes', 90] }, 60000] }],
            },
          ],
        },
        at,
      ],
    },
  };
}
export async function availableTables(
  at: Date,
  partySize: number,
  duration: number,
  exclude?: string,
) {
  validateBookingTime(at, duration);
  await checkHours(at, duration);
  const tables = await TableModel.find({
    isActive: true,
    capacity: { $gte: partySize },
    mergedIntoTableId: null,
  })
    .sort({ capacity: 1, number: 1 })
    .lean();
  const available = [];
  for (const t of tables) {
    if (!(await ReservationModel.exists(overlapFilter(t._id, at, duration, exclude))))
      available.push({ _id: String(t._id), number: t.number, capacity: t.capacity, zone: t.zone });
  }
  return available;
}
async function allocateTable(
  tableId: string | undefined,
  at: Date,
  partySize: number,
  duration: number,
  exclude: string,
  session: ClientSession,
) {
  const candidates = await TableModel.find({
    isActive: true,
    capacity: { $gte: partySize },
    mergedIntoTableId: null,
    ...(tableId ? { _id: new Types.ObjectId(tableId) } : {}),
  })
    .sort({ capacity: 1, number: 1 })
    .session(session);
  for (const t of candidates) {
    // All allocation paths write the table, serializing competing reservations.
    await TableModel.updateOne({ _id: t._id }, { $inc: { scheduleVersion: 1 } }, { session });
    if (
      !(await ReservationModel.exists(overlapFilter(t._id, at, duration, exclude)).session(session))
    )
      return t;
  }
  throw AppError.conflict('No suitable table is available for this time and duration');
}
async function audit(
  id: string,
  action: string,
  ctx: ActorCtx,
  metadata: Record<string, unknown>,
  session: ClientSession,
) {
  await AuditLogModel.create(
    [{ ...ctx, action, entity: 'Reservation', entityId: id, metadata, at: new Date() }],
    { session },
  );
}
export async function createReservation(
  input: {
    guestName: string;
    guestPhone?: string;
    guestEmail?: string;
    partySize: number;
    reservedAt: Date | string;
    durationMinutes?: number;
    notes?: string;
    kind?: 'reservation' | 'waitlist';
  },
  ctx: ActorCtx,
) {
  const at =
      typeof input.reservedAt === 'string' && input.reservedAt.length === 16
        ? pacificDateTime(input.reservedAt.slice(0, 10), input.reservedAt.slice(11))
        : new Date(input.reservedAt),
    duration = input.durationMinutes ?? 90;
  if (input.kind !== 'waitlist') validateBookingTime(at, duration);
  const restaurant = await getOrCreateRestaurant();
  return mongoose.connection.transaction(async (session) => {
    const [r] = await ReservationModel.create(
      [
        {
          ...input,
          reservedAt: at,
          durationMinutes: duration,
          endsAt: new Date(at.getTime() + duration * 60000),
          restaurantId: restaurant._id,
          status: 'pending',
        },
      ],
      { session },
    );
    await audit(
      String(r._id),
      'reservation.create',
      ctx,
      { kind: r.kind, partySize: r.partySize },
      session,
    );
    return r;
  });
}
export async function updateReservation(
  id: string,
  input: { status: ReservationStatus; tableId?: string; durationMinutes?: number; reason?: string },
  ctx: ActorCtx = {},
) {
  return mongoose.connection.transaction(async (session) => {
    const r = await ReservationModel.findById(id).session(session);
    if (!r) throw AppError.notFound('Reservation not found');
    validateReservationTransition(r.status, input.status);
    if (r.status === input.status) return r;
    const from = r.status;
    if (input.status === 'confirmed') {
      const at = isWaitlist(r) ? new Date(Date.now() + 60000) : r.reservedAt;
      const duration = input.durationMinutes ?? r.durationMinutes ?? 90;
      validateBookingTime(at, duration);
      await checkHours(at, duration);
      const table = await allocateTable(input.tableId, at, r.partySize, duration, id, session);
      r.tableId = table._id;
      r.reservedAt = at;
      r.durationMinutes = duration;
      r.endsAt = new Date(at.getTime() + duration * 60000);
    }
    if (input.status === 'checked_in') {
      if (!r.tableId) throw AppError.conflict('Confirm a table before seating this booking');
      if (input.tableId && input.tableId !== String(r.tableId))
        throw AppError.conflict('Seat guests at their assigned table');
      if (
        r.reservedAt.getTime() > Date.now() + 30 * 60000 ||
        (r.endsAt?.getTime() ?? 0) <= Date.now()
      )
        throw AppError.conflict(
          'Check-in is available from 30 minutes before the booking until its end',
        );
      const table = await TableModel.findOneAndUpdate(
        {
          _id: r.tableId,
          isActive: true,
          status: 'vacant',
          currentSessionId: null,
          mergedIntoTableId: null,
        },
        { $inc: { scheduleVersion: 1 }, $set: { status: 'seated' } },
        { new: true, session },
      );
      if (!table)
        throw AppError.conflict('The assigned table must be vacant and ready before seating');
      const [visit] = await TableSessionModel.create(
        [
          {
            tableId: table._id,
            currency: (await getOrCreateRestaurant()).currency,
            guestCount: r.partySize,
            notes: `Reservation ${String(r._id)}`,
          },
        ],
        { session },
      );
      table.currentSessionId = visit._id;
      await table.save({ session });
      r.tableSessionId = visit._id;
      r.checkedInAt = new Date();
    }
    if (input.status === 'completed') r.completedAt = new Date();
    if (input.status === 'cancelled') {
      r.cancelledAt = new Date();
      r.cancellationReason = input.reason;
    }
    r.status = input.status;
    await r.save({ session });
    await audit(
      id,
      'reservation.status',
      ctx,
      { from, to: r.status, tableId: r.tableId, durationMinutes: r.durationMinutes },
      session,
    );
    return r;
  });
}
export const checkInReservation = (id: string, tableId?: string, ctx?: ActorCtx) =>
  updateReservation(id, { status: 'checked_in', tableId }, ctx);
export const completeReservation = (id: string, ctx?: ActorCtx) =>
  updateReservation(id, { status: 'completed' }, ctx);
export const cancelReservation = (id: string, reason?: string, ctx?: ActorCtx) =>
  updateReservation(id, { status: 'cancelled', reason }, ctx);
export async function changeGuestReservation(
  id: string,
  input: { date?: string; time?: string; partySize?: number; cancel?: boolean },
) {
  return mongoose.connection.transaction(async (session) => {
    const r = await ReservationModel.findById(id).session(session);
    if (!r || isWaitlist(r)) throw AppError.notFound('Reservation not found');
    if (!['pending', 'confirmed'].includes(r.status))
      throw AppError.conflict('This booking can no longer be changed online');
    if (input.cancel) {
      r.status = 'cancelled';
      r.cancelledAt = new Date();
      r.cancellationReason = 'Guest cancellation';
    } else {
      const at = pacificDateTime(input.date!, input.time!);
      validateBookingTime(at, r.durationMinutes);
      r.reservedAt = at;
      r.endsAt = new Date(at.getTime() + r.durationMinutes * 60000);
      r.partySize = input.partySize!;
      r.status = 'pending';
      r.tableId = undefined;
    }
    await r.save({ session });
    await audit(
      id,
      input.cancel ? 'reservation.guest_cancel' : 'reservation.guest_change',
      {},
      { status: r.status },
      session,
    );
    return r;
  });
}
export async function getReservationsForDate(date: Date, limit = 50) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  return ReservationModel.find({
    ...bookingFilter,
    reservedAt: {
      $gte: pacificDateTime(day, '00:00'),
      $lte: new Date(pacificDateTime(day, '23:59').getTime() + 59999),
    },
    status: { $in: ['pending', 'confirmed', 'checked_in'] },
  })
    .sort({ reservedAt: 1 })
    .limit(limit)
    .lean();
}
export async function getUpcomingReservations(days = 7, limit = 50) {
  return ReservationModel.find({
    ...bookingFilter,
    reservedAt: {
      $gte: new Date(),
      $lte: new Date(Date.now() + Math.min(150, Math.max(1, days)) * 86400000),
    },
    status: { $in: ['pending', 'confirmed'] },
  })
    .sort({ reservedAt: 1 })
    .limit(limit)
    .lean();
}
