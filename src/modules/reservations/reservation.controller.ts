import { ReservationModel } from './reservation.model';
import { reservationDTO } from './reservation.dto';
import { signReservationAccess, verifyReservationAccess } from './reservationAccess';
import { pacificDateTime } from '@utils/pacificDateTime';
import * as waitlist from './waitlist.service';
import { AppError } from '@utils/AppError';
import { writeAuditLog } from '@modules/audit/audit.service';
import { paginated } from '@utils/apiResponse';
import { Request, Response } from 'express';
import { asyncHandler } from '@utils/asyncHandler';
import { ok, created } from '@utils/apiResponse';
import * as svc from './reservation.service';

const ctx = (req: Request) => ({
  actorId: req.user?.id,
  actorEmail: req.user?.email,
  actorRole: req.user?.role.key,
});

export const createReservation = asyncHandler(async (req: Request, res: Response) => {
  const reservation = await svc.createReservation(req.body, ctx(req));
  return created(res, reservationDTO(reservation));
});

export const checkIn = asyncHandler(async (req: Request, res: Response) => {
  const reservation = await svc.checkInReservation(req.params.id, req.body.tableId, ctx(req));
  return ok(res, reservation);
});

export const complete = asyncHandler(async (req: Request, res: Response) => {
  const reservation = await svc.completeReservation(req.params.id, ctx(req));
  return ok(res, reservation);
});

export const cancel = asyncHandler(async (req: Request, res: Response) => {
  const reservation = await svc.cancelReservation(req.params.id, req.body.reason, ctx(req));
  return ok(res, reservation);
});

export const upcomingList = asyncHandler(async (req: Request, res: Response) => {
  const days = parseInt((req.query.days as string) || '7');
  const reservations = await svc.getUpcomingReservations(days);
  return ok(res, { reservations, count: reservations.length });
});

export const todayList = asyncHandler(async (req: Request, res: Response) => {
  const reservations = await svc.getReservationsForDate(new Date());
  return ok(res, { reservations, count: reservations.length });
});

// Guest bookings remain requests until a table is allocated by staff.
export const createGuest = asyncHandler(async (req: Request, res: Response) => {
  const input = req.body;
  const reservation = await svc.createReservation(
    {
      guestName: input.name,
      guestEmail: input.email,
      guestPhone: input.phone,
      partySize: input.partySize,
      reservedAt: pacificDateTime(input.date, input.time),
      notes: [input.seatingPreference, input.notes].filter(Boolean).join(' — '),
    },
    {},
  );
  return created(res, {
    ...reservationDTO(reservation),
    managementToken: signReservationAccess(String(reservation._id)),
  });
});
export const getGuest = asyncHandler(async (req: Request, res: Response) => {
  verifyReservationAccess(req.get('X-Reservation-Token'), req.params.id);
  const r = await ReservationModel.findOne({ _id: req.params.id, ...svc.bookingFilter });
  if (!r) throw AppError.notFound('Reservation not found');
  return ok(res, reservationDTO(r));
});
export const changeGuest = asyncHandler(async (req: Request, res: Response) => {
  verifyReservationAccess(req.get('X-Reservation-Token'), req.params.id);
  return ok(res, reservationDTO(await svc.changeGuestReservation(req.params.id, req.body)));
});
export const availability = asyncHandler(async (req: Request, res: Response) => {
  return ok(
    res,
    await svc.availableTables(
      pacificDateTime(String(req.query.date), String(req.query.time)),
      Number(req.query.partySize),
      Number(req.query.durationMinutes ?? 90),
      req.query.excludeId as string | undefined,
    ),
  );
});
export const listWaitlist = asyncHandler(async (_req: Request, res: Response) =>
  ok(res, (await waitlist.getWaitlist()).map(reservationDTO)),
);
export const createWaitlist = asyncHandler(async (req: Request, res: Response) =>
  created(res, reservationDTO(await waitlist.addToWaitlist(req.body, ctx(req)))),
);

export const list = asyncHandler(async (req: Request, res: Response) => {
  const page = Number(req.query.page ?? 1),
    limit = Number(req.query.limit ?? 50);
  const filter: Record<string, unknown> = { ...svc.bookingFilter };
  if (req.query.status) filter.status = req.query.status;
  if (req.query.q) {
    const literal = String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [
      { guestName: { $regex: literal, $options: 'i' } },
      { guestEmail: { $regex: literal, $options: 'i' } },
    ];
  }
  if (req.query.from || req.query.to) {
    const { pacificDateTime } = await import('@utils/pacificDateTime');
    filter.reservedAt = {
      ...(req.query.from ? { $gte: pacificDateTime(String(req.query.from), '00:00') } : {}),
      ...(req.query.to
        ? { $lte: new Date(pacificDateTime(String(req.query.to), '23:59').getTime() + 59999) }
        : {}),
    };
  }
  const [items, total] = await Promise.all([
    ReservationModel.find(filter)
      .sort({ reservedAt: 1 })
      .skip((page - 1) * limit)
      .limit(limit),
    ReservationModel.countDocuments(filter),
  ]);
  return paginated(res, items.map(reservationDTO), {
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  });
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  return ok(res, reservationDTO(await svc.updateReservation(req.params.id, req.body, ctx(req))));
});
