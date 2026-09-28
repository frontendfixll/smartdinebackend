import { Request, Response } from 'express';
import { asyncHandler } from '@utils/asyncHandler';
import { ok, created, paginated } from '@utils/apiResponse';
import * as svc from './payment.service';
import { verifyWebhookSignature } from '@providers/razorpay.provider';
import { constructWebhookEvent } from '@providers/stripe.provider';
import { AppError } from '@utils/AppError';
import { logger } from '@utils/logger';

const ctx = (req: Request) => ({
  actorId: req.user?.id,
  actorEmail: req.user?.email,
  actorRole: req.user?.role.key,
  actorName: req.user?.name,
  actorPermissions: req.user?.role.permissions,
});

export const record = asyncHandler(async (req: Request, res: Response) => {
  const payment = await svc.recordPayment(
    { invoiceId: req.params.invoiceId, ...req.body, idempotencyKey: req.get('Idempotency-Key') },
    ctx(req),
  );
  return created(res, payment);
});

export const list = asyncHandler(async (req: Request, res: Response) => {
  const { items, meta } = await svc.listPayments(req.query as svc.ListPaymentsOpts);
  return paginated(res, items, meta);
});

export const upiQr = asyncHandler(async (req: Request, res: Response) => {
  const result = await svc.createUpiQrPayment({ invoiceId: req.body.invoiceId }, ctx(req));
  return created(res, result);
});

export const cardIntent = asyncHandler(async (req: Request, res: Response) => {
  const result = await svc.createCardPayment({ invoiceId: req.body.invoiceId }, ctx(req));
  return created(res, result);
});

export const refund = asyncHandler(async (req: Request, res: Response) => {
  const r = await svc.refundPayment(
    { paymentId: req.params.id, ...req.body, idempotencyKey: req.get('Idempotency-Key') },
    ctx(req),
  );
  return created(res, r);
});

export const razorpayWebhook = asyncHandler(async (req: Request, res: Response) => {
  const signature = (req.headers['x-razorpay-signature'] as string) ?? '';
  const raw = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!raw) throw AppError.badRequest('Missing raw body for signature verification');
  if (!verifyWebhookSignature({ rawBody: raw, signature })) {
    logger.warn('Razorpay webhook: invalid signature');
    throw AppError.unauthorized('Invalid webhook signature');
  }
  const event = req.body;
  const result = await svc.handleRazorpayWebhook(event);
  return ok(res, result);
});

export const stripeWebhook = asyncHandler(async (req: Request, res: Response) => {
  const signature = (req.headers['stripe-signature'] as string) ?? '';
  const raw = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!raw) throw AppError.badRequest('Missing raw body for signature verification');
  // Throws on an invalid signature or an unconfigured secret — an unverified event is never trusted.
  const event = constructWebhookEvent(raw, signature);
  const result = await svc.handleStripeWebhook(event);
  return ok(res, result);
});
