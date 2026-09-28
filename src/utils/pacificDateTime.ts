import { AppError } from './AppError';
/** Resolve a local Pacific wall-clock time; reject missing or ambiguous DST times. */
export function pacificDateTime(date: string, time: string): Date {
  const target = `${date}T${time}`;
  const utc = Date.parse(`${target}:00Z`);
  if (!Number.isFinite(utc)) throw AppError.badRequest('Invalid reservation date');
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const candidates = [7, 8]
    .map((offset) => new Date(utc + offset * 3600000))
    .filter((candidate) => {
      const parts = Object.fromEntries(
        formatter.formatToParts(candidate).map((p) => [p.type, p.value]),
      );
      return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}` === target;
    });
  if (candidates.length !== 1)
    throw AppError.badRequest('Choose an unambiguous, valid Pacific time');
  return candidates[0];
}
