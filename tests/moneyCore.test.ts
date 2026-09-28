import {
  addCents,
  allocate,
  allocateEqual,
  applyRate,
  assertCents,
  extractInclusiveTax,
  formatMoney,
  fromMajor,
  mulQty,
  roundCents,
  subCents,
  sumCents,
  toMajor,
} from '../src/utils/money';

describe('money core — conversion', () => {
  test('fromMajor parses dollars to integer cents', () => {
    expect(fromMajor(10.5)).toBe(1050);
    expect(fromMajor(0.01)).toBe(1);
    expect(fromMajor(1025.5)).toBe(102550);
  });
  test('fromMajor rejects sub-cent prices', () => {
    expect(() => fromMajor(1.005)).toThrow('FRACTIONAL_CENT');
  });
  test('toMajor round-trips cents to a two-decimal number', () => {
    expect(toMajor(1050)).toBe(10.5);
    expect(toMajor(102550)).toBe(1025.5);
    expect(toMajor(1)).toBe(0.01);
  });
  test('assertCents rejects non-integer values', () => {
    expect(() => assertCents(10.5)).toThrow('INVALID_CENTS');
    expect(() => assertCents(NaN)).toThrow('INVALID_CENTS');
    expect(assertCents(1050)).toBe(1050);
  });
});

describe('money core — arithmetic', () => {
  test('sum/add/sub stay exact where floats would drift', () => {
    expect(sumCents([10, 20])).toBe(30); // 0.10 + 0.20
    expect(addCents(1, 2, 3)).toBe(6);
    expect(subCents(1000, 1, 2)).toBe(997);
  });
  test('mulQty multiplies unit price by quantity', () => {
    expect(mulQty(1050, 3)).toBe(3150);
    expect(mulQty(1050, 0)).toBe(0);
    expect(() => mulQty(1050, -1)).toThrow('INVALID_QTY');
    expect(() => mulQty(1050, 1.5)).toThrow('INVALID_QTY');
  });
  test('roundCents halves away from zero', () => {
    expect(roundCents(100.4)).toBe(100);
    expect(roundCents(100.5)).toBe(101);
    expect(roundCents(-100.5)).toBe(-101);
  });
});

describe('money core — rates', () => {
  test('applyRate computes tax in whole cents', () => {
    // 8.25% of $100.00 = $8.25
    expect(applyRate(10000, 8.25)).toBe(825);
    // 8.25% of $12.34 = 101.805c -> 102c
    expect(applyRate(1234, 8.25)).toBe(102);
    expect(applyRate(1234, 0)).toBe(0);
  });
  test('extractInclusiveTax splits a gross amount so base + tax === gross', () => {
    const { base, tax } = extractInclusiveTax(10825, 8.25);
    expect(base + tax).toBe(10825);
    expect(base).toBe(10000);
    expect(tax).toBe(825);
  });
  test('extractInclusiveTax with zero rate returns the whole as base', () => {
    expect(extractInclusiveTax(5000, 0)).toEqual({ base: 5000, tax: 0 });
  });
});

describe('money core — allocation', () => {
  test('allocate distributes remainder so shares sum exactly to total', () => {
    const shares = allocate(1000, [1, 1, 1]); // $10 across 3
    expect(shares.reduce((s, v) => s + v, 0)).toBe(1000);
    expect(shares).toEqual([334, 333, 333]);
  });
  test('allocate honours weights', () => {
    const shares = allocate(10000, [1, 3]); // 25% / 75%
    expect(shares).toEqual([2500, 7500]);
  });
  test('allocateEqual never loses or invents a cent', () => {
    for (const [total, n] of [
      [100, 3],
      [101, 3],
      [1, 7],
      [99999, 4],
    ] as const) {
      const shares = allocateEqual(total, n);
      expect(shares).toHaveLength(n);
      expect(shares.reduce((s, v) => s + v, 0)).toBe(total);
      expect(Math.max(...shares) - Math.min(...shares)).toBeLessThanOrEqual(1);
    }
  });
  test('allocate with zero weights puts everything on the first share', () => {
    expect(allocate(500, [0, 0, 0])).toEqual([500, 0, 0]);
  });
  test('tax breakup distribution reconstructs the combined tax', () => {
    // Combined 8.25% tax of $12.34 = 102c split across 5% + 3.25% components.
    const tax = applyRate(1234, 8.25);
    const parts = allocate(tax, [5, 3.25]);
    expect(parts.reduce((s, v) => s + v, 0)).toBe(tax);
  });
});

describe('money core — formatting', () => {
  test('formatMoney renders grouped major units with two minor digits', () => {
    expect(formatMoney(102550, 'USD')).toBe('$1,025.50');
    expect(formatMoney(5, 'USD')).toBe('$0.05');
    expect(formatMoney(-1250, 'USD')).toBe('-$12.50');
    expect(formatMoney(1050, 'INR')).toBe('₹10.50');
  });
});
