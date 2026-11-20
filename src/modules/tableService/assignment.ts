import { ClientSession, Types } from 'mongoose';
import { ShiftModel } from '@modules/shifts/shift.model';
import { TableSessionModel } from '@modules/tables/tableSession.model';
import { UserModel } from '@modules/users/user.model';
import { RoleModel } from '@modules/roles/role.model';
import { AppError } from '@utils/AppError';

export function pilotZone(zone?: string) {
  const zones = (process.env.QR_SERVICE_ZONES || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  return zones.includes('*') || (!!zone && zones.includes(zone));
}

interface Candidate {
  id: string;
  covers: number;
  tables: number;
  lastAssigned: number;
  priority: number;
}

export function rankWaiters(candidates: Candidate[]) {
  return candidates.sort(
    (a, b) =>
      a.priority - b.priority ||
      a.covers - b.covers ||
      a.tables - b.tables ||
      a.lastAssigned - b.lastAssigned ||
      a.id.localeCompare(b.id),
  );
}

export async function seatingOwner(
  zone: string | undefined,
  party: number,
  transaction: ClientSession,
  preferred?: string,
  forcePilot = false,
  excludeVisit?: Types.ObjectId,
) {
  if (!forcePilot && !pilotZone(zone)) return { waiterId: preferred };
  const shadow = !forcePilot && process.env.QR_SERVICE_MODE !== 'live';
  const role = await RoleModel.findOne({ key: 'waiter' }).session(transaction).lean();
  const users = role
    ? await UserModel.find({ roleId: role._id, isActive: true })
        .select('name')
        .session(transaction)
        .lean()
    : [];
  const shifts = await ShiftModel.find({
    userId: { $in: users.map((u) => u._id) },
    status: 'open',
    breaks: { $not: { $elemMatch: { endedAt: null } } },
  })
    .session(transaction)
    .lean();
  const active = await TableSessionModel.find({
    status: 'open',
    ...(excludeVisit ? { _id: { $ne: excludeVisit } } : {}),
    $or: [
      { waiterId: { $in: shifts.map((s) => s.userId) } },
      { offerTo: { $in: shifts.map((s) => s.userId) }, offerExpiresAt: { $gt: new Date() } },
    ],
  })
    .select('waiterId guestCount offerTo offerExpiresAt')
    .session(transaction)
    .lean();
  const candidates = shifts.flatMap((shift) => {
    const id = String(shift.userId);
    const home = !shift.serviceZone || shift.serviceZone === zone;
    const myVisits = active.filter(
      (v) =>
        String(v.waiterId) === id ||
        (String(v.offerTo) === id && (v.offerExpiresAt?.getTime() ?? 0) > Date.now()),
    );
    const covers = myVisits.reduce((n, v) => n + v.guestCount, party);
    if (
      (!home && !shift.serviceOverflow) ||
      covers > (shift.maxServiceCovers ?? 16) ||
      myVisits.length >= (shift.maxServiceTables ?? 5) ||
      (!shadow && preferred && preferred !== id)
    )
      return [];
    return [
      {
        id,
        covers,
        tables: myVisits.length + 1,
        lastAssigned: shift.lastServiceAt?.getTime() ?? 0,
        priority: shift.serviceZone === zone && !!zone ? 0 : home ? 1 : 2,
      },
    ];
  });
  const winner = rankWaiters(candidates)[0];
  if (shadow) return { waiterId: preferred, suggestedWaiterId: winner?.id };
  if (!winner && preferred)
    throw AppError.conflict('Selected waiter is unavailable or at capacity');
  if (!winner) return { qrService: true, assignmentVersion: 0 };
  const waiterId = new Types.ObjectId(winner.id);
  // Every assignment writes the chosen shift, so competing seating transactions retry against the new load.
  await ShiftModel.updateOne(
    { userId: waiterId, status: 'open' },
    { $set: { lastServiceAt: new Date() }, $inc: { serviceVersion: 1 } },
    { session: transaction },
  );
  return {
    qrService: true,
    assignmentVersion: 0,
    assignedAt: new Date(),
    waiterId,
    waiterName: users.find((u) => u._id.equals(waiterId))?.name,
  };
}
