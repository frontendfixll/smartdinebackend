import { toMinorUnitsExact } from '../src/utils/money';
describe('exact cent conversion', () => {
  test('accepts ordinary cent values and binary addition noise', () => {
    expect(toMinorUnitsExact(1.01)).toBe(101);
    expect(toMinorUnitsExact(0.1 + 0.2)).toBe(30);
    expect(toMinorUnitsExact(-0.01)).toBe(-1);
    expect(toMinorUnitsExact(0)).toBe(0);
    expect(toMinorUnitsExact(9000000.99)).toBe(900000099);
  });
  test('refuses sub-cent values instead of silently changing them', () => {
    expect(() => toMinorUnitsExact(1.005)).toThrow('FRACTIONAL_CENT');
    expect(() => toMinorUnitsExact(0.001)).toThrow('FRACTIONAL_CENT');
    expect(() => toMinorUnitsExact(1.0000000001)).toThrow('FRACTIONAL_CENT');
  });
  test('refuses missing, non-finite and unsafe amounts', () => {
    for (const value of [undefined, null, '1.00', NaN, Infinity])
      expect(() => toMinorUnitsExact(value)).toThrow('INVALID_AMOUNT');
    expect(() => toMinorUnitsExact(Number.MAX_SAFE_INTEGER)).toThrow('UNSAFE_AMOUNT');
  });
});
