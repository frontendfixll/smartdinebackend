import { OrderItem, OrderTotals } from './order.model';
import { RestaurantDocument } from '@modules/restaurant/restaurant.model';
import {
  addCents,
  allocate,
  applyRate,
  extractInclusiveTax,
  fromMajor,
  mulQty,
  roundCents,
  subCents,
  sumCents,
  toMajor,
} from '@utils/money';

export interface PricingInput {
  items: OrderItem[];
  restaurant: Pick<RestaurantDocument, 'tax'>;
  /** Discount in major units (dollars), matching the stored order contract. */
  discount?: number;
}

/**
 * Integer-cent totals. Same shape as {@link OrderTotals} but every monetary field is
 * whole cents. This is the authoritative money engine; nothing here uses float dollars.
 */
export interface OrderTotalsCents {
  subtotal: number;
  modifierTotal: number;
  discount: number;
  serviceCharge: number;
  tax: number;
  taxBreakup: Array<{ name: string; type: string; rate: number; amount: number }>;
  roundOff: number;
  grand: number;
}

/** Compute order totals in exact integer cents. Item prices arrive as major-unit numbers. */
export function computeTotalsCents({
  items,
  restaurant,
  discount = 0,
}: PricingInput): OrderTotalsCents {
  let subtotal = 0;
  let modifierTotal = 0;

  for (const it of items) {
    if (it.status === 'cancelled') {
      it.lineTotal = 0;
      continue;
    }
    const baseCents = fromMajor(it.basePrice);
    const modSumCents = sumCents(it.modifiers.map((m) => fromMajor(m.priceDelta || 0)));
    const unitCents = addCents(baseCents, modSumCents);
    // lineTotal stays in major units to preserve the current stored order contract.
    it.lineTotal = toMajor(mulQty(unitCents, it.qty));
    subtotal = addCents(subtotal, mulQty(baseCents, it.qty));
    modifierTotal = addCents(modifierTotal, mulQty(modSumCents, it.qty));
  }

  const discountCents = fromMajor(discount);
  const taxableBase = subCents(addCents(subtotal, modifierTotal), discountCents);
  const serviceCharge = applyRate(taxableBase, restaurant.tax.serviceChargePercent || 0);

  const totalRate = restaurant.tax.taxes.reduce((s, t) => s + t.rate, 0);
  let taxBase: number;
  let tax: number;
  let taxBreakup: OrderTotalsCents['taxBreakup'];

  if (restaurant.tax.taxInclusive && totalRate > 0) {
    // Prices already include tax: back the tax out of the taxable base + service charge.
    const inclusive = addCents(taxableBase, serviceCharge);
    const extracted = extractInclusiveTax(inclusive, totalRate);
    taxBase = extracted.base;
    tax = extracted.tax;
    // Distribute the extracted tax across components so the parts sum exactly to `tax`.
    const parts = allocate(
      tax,
      restaurant.tax.taxes.map((t) => t.rate),
    );
    taxBreakup = restaurant.tax.taxes.map((t, i) => ({
      name: t.name,
      type: t.type,
      rate: t.rate,
      amount: parts[i],
    }));
  } else {
    taxBase = addCents(taxableBase, serviceCharge);
    taxBreakup = restaurant.tax.taxes.map((t) => ({
      name: t.name,
      type: t.type,
      rate: t.rate,
      amount: applyRate(taxBase, t.rate),
    }));
    tax = sumCents(taxBreakup.map((t) => t.amount));
  }

  const preRound = restaurant.tax.taxInclusive
    ? addCents(taxableBase, serviceCharge)
    : addCents(taxBase, tax);

  let grand = preRound;
  let roundOff = 0;
  if (restaurant.tax.roundingRule === 'nearest_rupee') {
    // Round to the nearest whole major unit (100 cents).
    const rounded = roundCents(grand / 100) * 100;
    roundOff = rounded - grand;
    grand = rounded;
  } else if (restaurant.tax.roundingRule === 'nearest_50_paise') {
    // Round to the nearest 50 cents.
    const rounded = roundCents(grand / 50) * 50;
    roundOff = rounded - grand;
    grand = rounded;
  }

  return {
    subtotal,
    modifierTotal,
    discount: discountCents,
    serviceCharge,
    tax,
    taxBreakup,
    roundOff,
    grand,
  };
}

/**
 * Backwards-compatible major-unit totals for callers that still store/emit dollars.
 * Computes in exact cents internally, then converts. New cent-native storage should
 * call {@link computeTotalsCents} directly.
 */
export function computeTotals(input: PricingInput): OrderTotals {
  const cents = computeTotalsCents(input);
  return {
    subtotal: toMajor(cents.subtotal),
    modifierTotal: toMajor(cents.modifierTotal),
    discount: toMajor(cents.discount),
    serviceCharge: toMajor(cents.serviceCharge),
    tax: toMajor(cents.tax),
    taxBreakup: cents.taxBreakup.map((t) => ({ ...t, amount: toMajor(t.amount) })),
    roundOff: toMajor(cents.roundOff),
    grand: toMajor(cents.grand),
  };
}

export function estimatePrepMinutes(items: OrderItem[], queueDepth = 0): number {
  if (!items.length) return 0;
  // Items at the same station are sequential; stations are parallel.
  const byStation = new Map<string, number>();
  for (const it of items) {
    if (it.status === 'cancelled') continue;
    const station = it.station || 'default';
    const itemTime = 10; // fallback; menu prep time is snapshotted later in Phase 6+
    byStation.set(station, (byStation.get(station) ?? 0) + itemTime * it.qty);
  }
  const longest = Math.max(0, ...Array.from(byStation.values()));
  return longest + queueDepth * 2;
}
