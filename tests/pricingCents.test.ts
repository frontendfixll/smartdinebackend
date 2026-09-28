import { Types } from 'mongoose';
import { computeTotalsCents } from '../src/modules/orders/pricing';
import type { OrderItem } from '../src/modules/orders/order.model';
import type { RestaurantDocument } from '../src/modules/restaurant/restaurant.model';

function makeItem(overrides: Partial<OrderItem> = {}): OrderItem {
  return {
    _id: new Types.ObjectId(),
    itemId: new Types.ObjectId(),
    name: 'Item',
    qty: 1,
    basePrice: 10,
    modifiers: [],
    lineTotal: 0,
    status: 'pending',
    ...overrides,
  } as OrderItem;
}

function usRestaurant(overrides: Partial<RestaurantDocument['tax']> = {}) {
  return {
    tax: {
      gstin: undefined,
      taxes: [{ name: 'Sales Tax', rate: 8.25, type: 'other' as const, applyOn: 'subtotal' as const }],
      serviceChargePercent: 0,
      roundingRule: 'none' as const,
      taxInclusive: false,
      ...overrides,
    },
  } as Pick<RestaurantDocument, 'tax'>;
}

describe('computeTotalsCents — US sales tax, no rupee rounding', () => {
  test('returns whole-cent totals with 8.25% tax', () => {
    const totals = computeTotalsCents({
      items: [makeItem({ qty: 1, basePrice: 12.34 })],
      restaurant: usRestaurant(),
    });
    expect(totals.subtotal).toBe(1234);
    // 8.25% of 1234c = 101.805c -> 102c
    expect(totals.tax).toBe(102);
    expect(totals.roundOff).toBe(0);
    expect(totals.grand).toBe(1336);
    // taxBreakup amounts are integer cents
    expect(totals.taxBreakup[0].amount).toBe(102);
  });

  test('multi-item subtotal stays exact where float dollars would drift', () => {
    const totals = computeTotalsCents({
      items: [
        makeItem({ qty: 3, basePrice: 0.1 }),
        makeItem({ qty: 3, basePrice: 0.2 }),
      ],
      restaurant: usRestaurant({ taxes: [] }),
    });
    // 3*10c + 3*20c = 90c exactly
    expect(totals.subtotal).toBe(90);
    expect(totals.grand).toBe(90);
  });

  test('grand equals subtotal + serviceCharge + tax in cents', () => {
    const totals = computeTotalsCents({
      items: [makeItem({ qty: 2, basePrice: 25 })],
      restaurant: usRestaurant({ serviceChargePercent: 5 }),
    });
    expect(totals.subtotal).toBe(5000);
    expect(totals.serviceCharge).toBe(250); // 5% of 5000
    expect(totals.tax).toBe(433); // 8.25% of 5250 = 433.125 -> 433
    expect(totals.grand).toBe(totals.subtotal + totals.serviceCharge + totals.tax);
  });

  test('inclusive tax: base + tax reconstruct the gross with exact cents', () => {
    const totals = computeTotalsCents({
      items: [makeItem({ qty: 1, basePrice: 108.25 })],
      restaurant: usRestaurant({ taxInclusive: true }),
    });
    expect(totals.grand).toBe(10825);
    expect(totals.tax).toBe(825);
    expect(totals.taxBreakup.reduce((s, t) => s + t.amount, 0)).toBe(totals.tax);
  });
});
