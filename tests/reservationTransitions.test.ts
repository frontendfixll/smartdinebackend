import { validateReservationTransition } from '../src/modules/reservations/reservation.transitions';
test('reservation follows the operational lifecycle', () => {
  expect(() => validateReservationTransition('pending','confirmed')).not.toThrow();
  expect(() => validateReservationTransition('confirmed','checked_in')).not.toThrow();
  expect(() => validateReservationTransition('checked_in','completed')).not.toThrow();
});
test('completed/cancelled bookings cannot be reopened or falsely seated', () => {
  expect(() => validateReservationTransition('pending','completed')).toThrow();
  expect(() => validateReservationTransition('cancelled','checked_in')).toThrow();
  expect(() => validateReservationTransition('completed','confirmed')).toThrow();
});
