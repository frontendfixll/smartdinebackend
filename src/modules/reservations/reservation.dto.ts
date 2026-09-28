import { ReservationDocument } from './reservation.model';
export function reservationDTO(r: ReservationDocument) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(r.reservedAt)
      .map((p) => [p.type, p.value]),
  );
  return {
    _id: String(r._id),
    reservationNumber: String(r._id).slice(-8).toUpperCase(),
    name: r.guestName,
    email: r.guestEmail,
    phone: r.guestPhone,
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    partySize: r.partySize,
    status: r.status,
    kind: r.kind,
    durationMinutes: r.durationMinutes,
    endsAt: r.endsAt,
    tableSessionId: r.tableSessionId ? String(r.tableSessionId) : undefined,
    tableId: r.tableId ? String(r.tableId) : undefined,
    notes: r.notes,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}
