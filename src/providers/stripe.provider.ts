import Stripe from 'stripe';
import { AppError } from '@utils/AppError';
import { assertCents } from '@utils/money';
import { config } from '@config/index';

/**
 * Stripe provider — the US card processor. Amounts are integer minor units
 * (cents), which is exactly what Stripe expects, so no float conversion happens here.
 *
 * When Stripe is not configured the create/refund calls throw SERVICE_UNAVAILABLE
 * rather than fabricating a successful charge. Local testing uses Stripe test keys
 * (`sk_test_...`); this provider never pretends to have moved real money.
 */

let client: Stripe | null = null;

export function stripeEnabled(): boolean {
  return config.stripe.enabled;
}

function getClient(): Stripe {
  if (!config.stripe.enabled)
    throw new AppError(
      'SERVICE_UNAVAILABLE',
      'Card payments are not configured. No payment has been initiated.',
    );
  if (!client) client = new Stripe(config.stripe.secretKey, { maxNetworkRetries: 2 });
  return client;
}

/** Stripe supports three-letter ISO currency codes in lowercase. */
function normalizeCurrency(currency: string): string {
  const code = String(currency || '').toLowerCase();
  if (!/^[a-z]{3}$/.test(code)) throw AppError.badRequest('Unsupported currency for card payment');
  return code;
}

export interface CreatePaymentIntentInput {
  amountCents: number;
  currency: string;
  /** Reused across retries so a lost response never creates a second intent. */
  idempotencyKey: string;
  metadata?: Record<string, string>;
  description?: string;
  /** Optional customer email for the Stripe receipt. */
  receiptEmail?: string;
}

export interface PaymentIntentResult {
  id: string;
  clientSecret: string | null;
  status: Stripe.PaymentIntent.Status;
  amountCents: number;
  currency: string;
}

/** Create a PaymentIntent for a card (or wallet) charge. Amount must be whole cents. */
export async function createPaymentIntent(
  input: CreatePaymentIntentInput,
): Promise<PaymentIntentResult> {
  assertCents(input.amountCents, 'amountCents');
  if (input.amountCents <= 0) throw AppError.badRequest('Payment amount must be positive');
  if (!input.idempotencyKey) throw AppError.badRequest('An idempotency key is required');
  const stripe = getClient();
  const intent = await stripe.paymentIntents.create(
    {
      amount: input.amountCents,
      currency: normalizeCurrency(input.currency),
      metadata: input.metadata,
      description: input.description,
      receipt_email: input.receiptEmail,
      automatic_payment_methods: { enabled: true },
    },
    { idempotencyKey: input.idempotencyKey },
  );
  return {
    id: intent.id,
    clientSecret: intent.client_secret,
    status: intent.status,
    amountCents: intent.amount,
    currency: intent.currency,
  };
}

export async function retrievePaymentIntent(id: string): Promise<Stripe.PaymentIntent> {
  return getClient().paymentIntents.retrieve(id);
}

export interface CreateRefundInput {
  paymentIntentId: string;
  amountCents: number;
  idempotencyKey: string;
  /** Human reason stored in metadata; Stripe's own reason enum is separate. */
  reason?: string;
}

export interface RefundResult {
  id: string;
  status: Stripe.Refund['status'];
  amountCents: number;
}

/** Refund all or part of a captured PaymentIntent. Amount must be whole cents. */
export async function createRefund(input: CreateRefundInput): Promise<RefundResult> {
  assertCents(input.amountCents, 'amountCents');
  if (input.amountCents <= 0) throw AppError.badRequest('Refund amount must be positive');
  if (!input.idempotencyKey) throw AppError.badRequest('An idempotency key is required');
  const stripe = getClient();
  const refund = await stripe.refunds.create(
    {
      payment_intent: input.paymentIntentId,
      amount: input.amountCents,
      reason: 'requested_by_customer',
      metadata: input.reason ? { reason: input.reason } : undefined,
    },
    { idempotencyKey: input.idempotencyKey },
  );
  return { id: refund.id, status: refund.status, amountCents: refund.amount };
}

/**
 * Verify and parse a Stripe webhook. Pass the RAW request body (not parsed JSON)
 * and the `stripe-signature` header. Throws if the signature is invalid or the
 * webhook secret is not configured — an unverified event is never trusted.
 */
export function constructWebhookEvent(rawBody: Buffer | string, signature: string): Stripe.Event {
  if (!config.stripe.webhookSecret)
    throw new AppError('SERVICE_UNAVAILABLE', 'Stripe webhook secret is not configured');
  const stripe = getClient();
  try {
    return stripe.webhooks.constructEvent(rawBody, signature, config.stripe.webhookSecret);
  } catch {
    throw AppError.badRequest('Invalid Stripe webhook signature');
  }
}
