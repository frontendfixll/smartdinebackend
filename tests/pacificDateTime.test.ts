import { pacificDateTime } from '../src/utils/pacificDateTime';
test('Pacific summer and winter offsets', () => {
  expect(pacificDateTime('2026-07-10', '12:00').toISOString()).toBe('2026-07-10T19:00:00.000Z');
  expect(pacificDateTime('2026-12-10', '12:00').toISOString()).toBe('2026-12-10T20:00:00.000Z');
});
test('rejects invalid, nonexistent and ambiguous local times', () => {
  expect(() => pacificDateTime('2026-02-30', '12:00')).toThrow();
  expect(() => pacificDateTime('2026-03-08', '02:30')).toThrow();
  expect(() => pacificDateTime('2026-11-01', '01:30')).toThrow();
});
