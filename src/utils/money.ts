/**
 * Money — integer-cent arithmetic.
 *
 * All monetary values inside the domain are integer minor units (cents for USD).
 * Never store or compute prices as floating-point major units: 0.1 + 0.2 !== 0.3.
 * Convert at the boundary (`fromMajor`) and format for display only (`toMajor`/`format`).
 */

/** Convert a two-decimal major-unit amount without silently rounding real fractions of a cent. */
export function toMinorUnitsExact(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('INVALID_AMOUNT');
  const decimal = String(value).match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);
  if (decimal) {
    const magnitude = BigInt(decimal[2]) * 100n + BigInt((decimal[3] ?? '').padEnd(2, '0'));
    const signed = decimal[1] ? -magnitude : magnitude;
    if (signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < BigInt(Number.MIN_SAFE_INTEGER))
      throw new Error('UNSAFE_AMOUNT');
    return Number(signed);
  }
  const scaled = value * 100;
  const cents = Math.round(scaled);
  if (!Number.isSafeInteger(cents)) throw new Error('UNSAFE_AMOUNT');
  // Accept ordinary binary floating-point noise, not prices such as 1.005.
  const tolerance = Math.min(1e-7, Number.EPSILON * Math.max(1, Math.abs(scaled)) * 4);
  if (Math.abs(scaled - cents) > tolerance) throw new Error('FRACTIONAL_CENT');
  return Object.is(cents, -0) ? 0 : cents;
}

/** Alias: parse a major-unit price/amount into integer cents. Throws on sub-cent values. */
export const fromMajor = toMinorUnitsExact;

/** Guard: a value that must already be integer cents (e.g. read from storage or an API). */
export function assertCents(value: unknown, label = 'amount'): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || !Number.isSafeInteger(value))
    throw new Error(`INVALID_CENTS:${label}`);
  return value;
}

/** Convert integer cents back to a two-decimal major-unit number for display/serialization. */
export function toMajor(cents: number): number {
  return assertCents(cents) / 100;
}

/** Round a fractional cent amount to the nearest whole cent, halves away from zero. */
export function roundCents(value: number): number {
  if (!Number.isFinite(value)) throw new Error('INVALID_AMOUNT');
  const rounded = value < 0 ? -Math.round(-value) : Math.round(value);
  if (!Number.isSafeInteger(rounded)) throw new Error('UNSAFE_AMOUNT');
  return rounded === 0 ? 0 : rounded;
}

/** Sum integer-cent amounts. */
export function sumCents(values: number[]): number {
  let total = 0;
  for (const value of values) total += assertCents(value);
  if (!Number.isSafeInteger(total)) throw new Error('UNSAFE_AMOUNT');
  return total;
}

/** Add integer-cent amounts. */
export function addCents(...values: number[]): number {
  return sumCents(values);
}

/** Subtract integer-cent amounts (a - b - ...). */
export function subCents(a: number, ...rest: number[]): number {
  let total = assertCents(a);
  for (const value of rest) total -= assertCents(value);
  if (!Number.isSafeInteger(total)) throw new Error('UNSAFE_AMOUNT');
  return total;
}

/** Multiply an integer-cent unit price by an integer quantity. */
export function mulQty(unitCents: number, qty: number): number {
  assertCents(unitCents);
  if (!Number.isInteger(qty) || qty < 0) throw new Error('INVALID_QTY');
  const product = unitCents * qty;
  if (!Number.isSafeInteger(product)) throw new Error('UNSAFE_AMOUNT');
  return product;
}

/**
 * Apply a percentage rate to a cents base and round to whole cents.
 * Used for tax and service-charge lines. `rate` is a percent (e.g. 8.25 for 8.25%).
 */
export function applyRate(baseCents: number, ratePercent: number): number {
  assertCents(baseCents);
  if (typeof ratePercent !== 'number' || !Number.isFinite(ratePercent))
    throw new Error('INVALID_RATE');
  return roundCents((baseCents * ratePercent) / 100);
}

/**
 * Back out an inclusive-tax component from a gross cents amount at a total percent rate.
 * Returns { base, tax } where base + tax === gross (in whole cents).
 */
export function extractInclusiveTax(
  grossCents: number,
  totalRatePercent: number,
): { base: number; tax: number } {
  assertCents(grossCents);
  if (totalRatePercent <= 0) return { base: grossCents, tax: 0 };
  const base = roundCents((grossCents * 100) / (100 + totalRatePercent));
  return { base, tax: grossCents - base };
}

/**
 * Split a cents total into integer-cent shares by weight, distributing the rounding
 * remainder deterministically (largest fractional remainder first, then by index).
 * Guarantees the shares sum exactly to `totalCents`. Used for equal/custom/item splits
 * and for distributing a combined tax figure across its component taxes.
 */
export function allocate(totalCents: number, weights: number[]): number[] {
  assertCents(totalCents);
  if (!weights.length) return [];
  if (weights.some((w) => typeof w !== 'number' || !Number.isFinite(w) || w < 0))
    throw new Error('INVALID_WEIGHTS');
  const weightSum = weights.reduce((s, w) => s + w, 0);
  if (weightSum === 0) {
    // No weights: put everything on the first share.
    return weights.map((_, i) => (i === 0 ? totalCents : 0));
  }
  const raw = weights.map((w) => (totalCents * w) / weightSum);
  const floors = raw.map((r) => (r < 0 ? Math.ceil(r) : Math.floor(r)));
  let remainder = totalCents - floors.reduce((s, f) => s + f, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - floors[i] }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  const step = remainder >= 0 ? 1 : -1;
  const shares = floors.slice();
  for (let k = 0; k < Math.abs(remainder); k++) shares[order[k % order.length].i] += step;
  return shares;
}

/** Split a cents total into `n` as-equal-as-possible integer-cent shares. */
export function allocateEqual(totalCents: number, n: number): number[] {
  if (!Number.isInteger(n) || n <= 0) throw new Error('INVALID_SPLIT_COUNT');
  return allocate(totalCents, new Array(n).fill(1));
}

const CURRENCY_SYMBOL: Record<string, string> = { USD: '$', INR: '₹' };

/** Format integer cents as a display string, e.g. formatMoney(102550,'USD') === '$1,025.50'. */
export function formatMoney(cents: number, currency = 'USD'): string {
  assertCents(cents);
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const major = Math.floor(abs / 100);
  const minor = String(abs % 100).padStart(2, '0');
  const grouped = major.toLocaleString('en-US');
  const symbol = CURRENCY_SYMBOL[currency] ?? '';
  return `${negative ? '-' : ''}${symbol}${grouped}.${minor}`;
}
