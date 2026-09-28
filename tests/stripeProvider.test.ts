jest.mock('../src/config', () => ({
  config: {
    stripe: { enabled: false, secretKey: '', publishableKey: '', webhookSecret: '' },
  },
}));

import {
  createPaymentIntent,
  createRefund,
  constructWebhookEvent,
  stripeEnabled,
} from '../src/providers/stripe.provider';

// The mocked config has no STRIPE_SECRET_KEY, so the provider is disabled.
// These checks prove it never fabricates a charge and validates cent amounts first.
describe('stripe provider — guardrails when not configured', () => {
  test('reports disabled without a secret key', () => {
    expect(stripeEnabled()).toBe(false);
  });

  test('createPaymentIntent refuses instead of pretending to charge', async () => {
    await expect(
      createPaymentIntent({ amountCents: 1000, currency: 'usd', idempotencyKey: 'k1' }),
    ).rejects.toThrow('not configured');
  });

  test('createRefund refuses instead of pretending to refund', async () => {
    await expect(
      createRefund({ paymentIntentId: 'pi_x', amountCents: 500, idempotencyKey: 'k2' }),
    ).rejects.toThrow('not configured');
  });

  test('constructWebhookEvent refuses an event without a configured secret', () => {
    expect(() => constructWebhookEvent('{}', 'sig')).toThrow();
  });
});

describe('stripe provider — cent-amount validation runs before any network call', () => {
  test('rejects non-integer cent amounts', async () => {
    await expect(
      createPaymentIntent({ amountCents: 10.5, currency: 'usd', idempotencyKey: 'k3' }),
    ).rejects.toThrow('INVALID_CENTS');
  });

  test('rejects non-positive amounts', async () => {
    await expect(
      createPaymentIntent({ amountCents: 0, currency: 'usd', idempotencyKey: 'k4' }),
    ).rejects.toThrow('positive');
    await expect(
      createRefund({ paymentIntentId: 'pi_x', amountCents: -1, idempotencyKey: 'k5' }),
    ).rejects.toThrow('positive');
  });
});
