import { ReservationModel } from './reservation.model';
import {
  createReservation,
  updateReservation,
  waitingFilter,
  ActorCtx,
} from './reservation.service';
import { AppError } from '@utils/AppError';
export const addToWaitlist = (
  input: { guestName: string; guestPhone?: string; partySize: number; notes?: string },
  ctx: ActorCtx = {},
) => createReservation({ ...input, reservedAt: new Date(), kind: 'waitlist' }, ctx);
export const getWaitlist = () =>
  ReservationModel.find({
    ...waitingFilter,
    status: { $in: ['pending', 'confirmed', 'checked_in'] },
  }).sort({ createdAt: 1 });
export async function callFromWaitlist(id: string, tableId?: string, ctx: ActorCtx = {}) {
  if (!(await ReservationModel.exists({ _id: id, ...waitingFilter })))
    throw AppError.notFound('Waitlist entry not found');
  return updateReservation(id, { status: 'confirmed', tableId }, ctx);
}
export async function removeFromWaitlist(id: string, reason?: string, ctx: ActorCtx = {}) {
  if (!(await ReservationModel.exists({ _id: id, ...waitingFilter })))
    throw AppError.notFound('Waitlist entry not found');
  return updateReservation(id, { status: 'cancelled', reason }, ctx);
}
export async function getWaitlistStats() {
  const waitlist = await getWaitlist();
  return {
    waitlistCount: waitlist.length,
    totalPeopleWaiting: waitlist.reduce((sum, r) => sum + r.partySize, 0),
    waitlist,
  };
}
