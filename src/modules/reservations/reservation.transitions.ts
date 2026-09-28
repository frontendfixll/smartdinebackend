import { ReservationStatus } from './reservation.model';
import { AppError } from '@utils/AppError';
const transitions: Record<ReservationStatus, ReservationStatus[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['checked_in', 'cancelled', 'no_show'],
  checked_in: ['completed'],
  completed: [],
  cancelled: [],
  no_show: [],
};
export function validateReservationTransition(from: ReservationStatus, to: ReservationStatus) {
  if (from !== to && !transitions[from].includes(to))
    throw AppError.conflict(`Cannot change ${from} reservation to ${to}`);
}
