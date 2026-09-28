import { getOrCreateRestaurant } from '@modules/restaurant/restaurant.service';
import { assertPaymentAmount } from './paymentGuards';
import { paymentBalance } from './paymentBalance';
import mongoose, { Types } from 'mongoose';
import { AuditLogModel } from '@modules/audit/auditLog.model';
import { PaymentModel, PaymentMode, PaymentProvider } from './payment.model';
import { RefundModel, RefundMethod } from './refund.model';
import { InvoiceModel } from '@modules/invoices/invoice.model';
import { OrderModel } from '@modules/orders/order.model';
import { CashSessionModel } from '@modules/cashSessions/cashSession.model';
import { AppError } from '@utils/AppError';
import { writeAuditLog } from '@modules/audit/audit.service';
import { refreshInvoicePaymentState } from '@modules/invoices/invoice.service';
import { createOrder as createRazorpayOrder } from '@providers/razorpay.provider';
import {
  createPaymentIntent,
  retrievePaymentIntent,
  stripeEnabled,
} from '@providers/stripe.provider';
import { fromMajor } from '@utils/money';
import { hasPermission } from '@modules/roles/permissions';
import { config } from '@config/index';
import { emitToStaff } from '@modules/orders/orderEvents';
import type Stripe from 'stripe';

interface ActorCtx {
  actorId?: string;
  actorEmail?: string;
  actorRole?: string;
  actorName?: string;
  actorPermissions?: string[];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface RecordPaymentInput {
  idempotencyKey?: string;
  invoiceId: string;
  splitId?: string;
  mode: PaymentMode;
  amount: number;
  provider?: PaymentProvider;
  txnRef?: string;
  cashTendered?: number;
  notes?: string;
  status?: 'pending' | 'success';
}

async function findOpenCashSession(cashierId?: string) {
  if (!cashierId) return null;
  return CashSessionModel.findOne({ cashierId: new Types.ObjectId(cashierId), status: 'open' });
}

export async function recordPayment(input: RecordPaymentInput, ctx: ActorCtx) {
  if (!['cash', 'card'].includes(input.mode))
    throw AppError.badRequest('Online payments must be confirmed by the configured provider');
  if (input.mode === 'card' && !input.txnRef?.trim())
    throw AppError.badRequest('Enter the successful external terminal transaction reference');
  if (!input.idempotencyKey || !/^[a-zA-Z0-9_-]{16,100}$/.test(input.idempotencyKey))
    throw AppError.badRequest('A valid Idempotency-Key is required');
  if (!ctx.actorId) throw AppError.unauthorized();
  const sameRequest = (payment: import('./payment.model').PaymentDocument) => {
    if (
      String(payment.invoiceId) !== input.invoiceId ||
      payment.amount !== round2(input.amount) ||
      payment.mode !== input.mode ||
      String(payment.splitId ?? '') !== (input.splitId ?? '') ||
      String(payment.cashierId) !== ctx.actorId
    )
      throw AppError.conflict('Idempotency key was already used for another payment');
    return payment;
  };
  let payment;
  try {
    payment = await mongoose.connection.transaction(async (session) => {
      const existing = await PaymentModel.findOne({ idempotencyKey: input.idempotencyKey }).session(
        session,
      );
      if (existing) return sameRequest(existing);
      const invoice = await InvoiceModel.findById(input.invoiceId).session(session);
      if (!invoice) throw AppError.notFound('Invoice not found');
      if (invoice.status !== 'final') throw AppError.conflict('Invoice is void');
      if (invoice.paymentStatus === 'paid' || invoice.paymentStatus === 'refunded')
        throw AppError.conflict('Invoice has no remaining balance');
      const paidPayments = await PaymentModel.find({
        invoiceId: invoice._id,
        status: { $in: ['success', 'refunded'] },
      }).session(session);
      const payable = round2(invoice.grand + (invoice.tip || 0));
      assertPaymentAmount(input.amount, paymentBalance(payable, paidPayments).amountDue);
      if (invoice.splits.length && !input.splitId)
        throw AppError.badRequest('Choose which guest split this payment belongs to');
      const split = input.splitId
        ? invoice.splits.find((s) => String(s._id) === input.splitId)
        : undefined;
      if (input.splitId && !split) throw AppError.notFound('Split not found');
      if (split) assertPaymentAmount(input.amount, round2(split.amount - split.paidAmount));
      if (input.status && input.status !== 'success')
        throw AppError.badRequest('Use the provider flow for pending payments');
      const cashSession =
        input.mode === 'cash'
          ? await CashSessionModel.findOne({
              cashierId: new Types.ObjectId(ctx.actorId),
              status: 'open',
            }).session(session)
          : null;
      if (input.mode === 'cash' && !cashSession)
        throw AppError.conflict('Open a cash session before accepting cash');
      const change =
        input.cashTendered === undefined ? undefined : round2(input.cashTendered - input.amount);
      if (input.mode === 'cash' && change !== undefined && change < 0)
        throw AppError.badRequest('Cash tendered less than amount');
      const [created] = await PaymentModel.create(
        [
          {
            invoiceId: invoice._id,
            orderId: invoice.orderId,
            splitId: split?._id,
            mode: input.mode,
            provider: input.provider,
            amount: round2(input.amount),
            status: 'success',
            txnRef: input.txnRef,
            idempotencyKey: input.idempotencyKey,
            cashTendered: input.cashTendered,
            changeReturned: change,
            cashierId: new Types.ObjectId(ctx.actorId),
            cashSessionId: cashSession?._id,
            receivedAt: new Date(),
            notes: input.notes,
          },
        ],
        { session },
      );
      if (split) {
        split.paidAmount = round2(split.paidAmount + input.amount);
        split.status = split.paidAmount >= split.amount ? 'paid' : 'partial';
      }
      const balance = paymentBalance(payable, [...paidPayments, created]);
      Object.assign(invoice, balance);
      // All concurrent tenders must write this invoice, making balance validation serializable.
      await invoice.save({ session });
      if (balance.paymentStatus === 'paid')
        await OrderModel.updateOne(
          { _id: invoice.orderId, status: { $nin: ['settled', 'cancelled'] } },
          { $set: { paymentStatus: 'paid' } },
          { session },
        );
      if (cashSession)
        await CashSessionModel.updateOne(
          { _id: cashSession._id },
          { $inc: { expectedCash: input.amount } },
          { session },
        );
      await AuditLogModel.create(
        [
          {
            ...ctx,
            action: 'payment.record',
            entity: 'Payment',
            entityId: String(created._id),
            at: new Date(),
            metadata: { amount: created.amount, mode: created.mode },
          },
        ],
        { session },
      );
      return created;
    });
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    const existing = await PaymentModel.findOne({ idempotencyKey: input.idempotencyKey });
    if (!existing) throw error;
    payment = sameRequest(existing);
  }
  await maybeSettleOrder(payment.orderId, ctx);
  emitToStaff('order:updated', {
    id: String(payment.orderId),
    invoiceId: String(payment.invoiceId),
  });
  return payment;
}

export async function maybeSettleOrder(orderId: Types.ObjectId, ctx: ActorCtx) {
  const result = await mongoose.connection.transaction(async (dbSession) => {
    const fresh = await InvoiceModel.findOne({ orderId, status: 'final' }).session(dbSession);
    if (!fresh || !['paid', 'refunded'].includes(fresh.paymentStatus)) return null;
    const order = await OrderModel.findById(orderId).session(dbSession);
    if (!order || ['settled', 'cancelled'].includes(order.status)) return null;
    order.paymentStatus = fresh.paymentStatus === 'refunded' ? 'refunded' : 'paid';
    if (order.status !== 'served') {
      await order.save({ session: dbSession });
      return null;
    }
    order.status = 'settled';
    order.timeline.push({
      _id: new Types.ObjectId(),
      status: 'settled',
      at: new Date(),
      byUserId: ctx.actorId ? new Types.ObjectId(ctx.actorId) : undefined,
      byName: ctx.actorName ?? ctx.actorEmail,
    });
    await order.save({ session: dbSession });
    let closedTableId: string | undefined;
    if (
      order.tableSessionId &&
      !(await OrderModel.exists({
        tableSessionId: order.tableSessionId,
        _id: { $ne: order._id },
        status: { $nin: ['settled', 'cancelled'] },
      }).session(dbSession))
    ) {
      const { TableSessionModel } = await import('@modules/tables/tableSession.model');
      const { TableModel } = await import('@modules/tables/table.model');
      const { ReservationModel } = await import('@modules/reservations/reservation.model');
      const visit = await TableSessionModel.findOneAndUpdate(
        { _id: order.tableSessionId, status: 'open' },
        { $set: { status: 'closed', closedAt: new Date() } },
        { new: true, session: dbSession },
      );
      if (visit && order.tableId) {
        await TableModel.updateOne(
          { _id: order.tableId, currentSessionId: order.tableSessionId },
          {
            $set: { status: 'cleaning' },
            $unset: { currentSessionId: 1 },
            $inc: { scheduleVersion: 1 },
          },
          { session: dbSession },
        );
        await ReservationModel.updateOne(
          { tableSessionId: order.tableSessionId, status: 'checked_in' },
          { $set: { status: 'completed', completedAt: new Date() } },
          { session: dbSession },
        );
        closedTableId = String(order.tableId);
      }
    }
    await AuditLogModel.create(
      [
        {
          ...ctx,
          action: 'order.settled',
          entity: 'Order',
          entityId: String(orderId),
          at: new Date(),
          metadata: { closedTableId },
        },
      ],
      { session: dbSession },
    );
    return { closedTableId };
  });
  if (!result) return;
  emitToStaff('order:status_changed', { id: String(orderId), status: 'settled' });
  if (result.closedTableId)
    emitToStaff('table:status_changed', { id: result.closedTableId, to: 'cleaning' });

  // Recipe-based inventory deduction. Fire-and-forget — a deduction failure
  // must never block the settle. The function is idempotent so retries are safe.
  import('@modules/inventory/inventoryDeduction.service')
    .then(({ deductOrderInventory }) => deductOrderInventory(orderId))
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('Inventory deduction failed for order', String(orderId), err);
    });

  // Update customer lifetime metrics (visit count, LTV, favorites). Fire-and-forget.
  import('@modules/customers/customer.service')
    .then(({ creditCustomerForOrder }) => creditCustomerForOrder(orderId))
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('Customer credit failed for order', String(orderId), err);
    });

  // Loyalty points earn. Fire-and-forget, idempotent.
  import('@modules/promotions/loyalty.service')
    .then(({ earnPointsForOrder }) => earnPointsForOrder(orderId))
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('Loyalty earn failed for order', String(orderId), err);
    });

  // Bill copy to guest if we have their phone. Fire-and-forget.
  Promise.all([
    import('@modules/orders/order.model'),
    import('@modules/invoices/invoice.model'),
    import('@modules/restaurant/restaurant.service'),
    import('@modules/notifications/notification.service'),
  ])
    .then(
      async ([{ OrderModel }, { InvoiceModel }, { getOrCreateRestaurant }, { dispatchSafe }]) => {
        const order = await OrderModel.findById(orderId).lean();
        if (!order || !order.guestPhone) return;
        const invoice = await InvoiceModel.findOne({ orderId, status: 'final' }).lean();
        if (!invoice) return;
        const r = await getOrCreateRestaurant();
        dispatchSafe({
          eventKey: 'order.settled.guest',
          to: order.guestPhone,
          payload: {
            restaurantName: r.brand.name,
            orderNumber: order.orderNumber,
            invoiceNumber: invoice.invoiceNumber,
            grand: invoice.grand,
            amountInWords: invoice.amountInWords,
          },
          relatedOrderId: order._id,
          relatedInvoiceId: invoice._id,
        });
      },
    )
    .catch(() => undefined);
}

export interface CreateUpiQrInput {
  invoiceId: string;
}

export async function createUpiQrPayment(input: CreateUpiQrInput, ctx: ActorCtx) {
  const invoice = await InvoiceModel.findById(input.invoiceId);
  if (!invoice) throw AppError.notFound('Invoice not found');
  if (invoice.paymentStatus === 'paid' || invoice.paymentStatus === 'refunded')
    throw AppError.conflict('Invoice has no remaining balance');

  const restaurant = await getOrCreateRestaurant();
  if (restaurant.currency !== 'INR')
    throw new AppError(
      'SERVICE_UNAVAILABLE',
      'The US payment provider has not been configured. No payment has been initiated.',
    );
  const order = await createRazorpayOrder({
    amount: invoice.amountDue,
    receipt: invoice.invoiceNumber,
    notes: { invoiceId: String(invoice._id), orderId: String(invoice.orderId) },
  });

  const payment = await PaymentModel.create({
    invoiceId: invoice._id,
    orderId: invoice.orderId,
    mode: 'upi',
    provider: 'razorpay',
    amount: round2(invoice.amountDue),
    status: 'pending',
    gatewayOrderId: order.orderId,
    cashierId: ctx.actorId ? new Types.ObjectId(ctx.actorId) : undefined,
    notes: order.mocked ? 'Mock — Razorpay not configured' : undefined,
  });

  await writeAuditLog({
    ...ctx,
    action: 'payment.upi_qr',
    entity: 'Payment',
    entityId: String(payment._id),
    metadata: {
      invoiceId: String(invoice._id),
      gatewayOrderId: order.orderId,
      mocked: order.mocked,
    },
  });

  return {
    paymentId: String(payment._id),
    gatewayOrderId: order.orderId,
    amount: invoice.amountDue,
    currency: 'INR',
    mocked: order.mocked,
    upiDeeplink: order.upiDeeplink,
    razorpayKeyId: config.razorpay.keyId || null,
  };
}

export interface CardPaymentResult {
  paymentId: string;
  provider: 'stripe';
  clientSecret: string | null;
  publishableKey: string | null;
  amount: number;
  currency: string;
}

/**
 * Create (or reuse) a Stripe PaymentIntent for the invoice's outstanding balance and
 * a matching pending Payment record. The guest confirms the intent client-side; the
 * signed webhook (`handleStripeWebhook`) is what actually marks the payment successful.
 */
export async function createCardPayment(
  input: { invoiceId: string },
  ctx: ActorCtx,
): Promise<CardPaymentResult> {
  const invoice = await InvoiceModel.findById(input.invoiceId);
  if (!invoice) throw AppError.notFound('Invoice not found');
  if (invoice.status !== 'final') throw AppError.conflict('Invoice is void');
  if (invoice.paymentStatus === 'paid' || invoice.paymentStatus === 'refunded')
    throw AppError.conflict('Invoice has no remaining balance');
  if (!stripeEnabled())
    throw new AppError(
      'SERVICE_UNAVAILABLE',
      'Card payments are not configured. No payment has been initiated.',
    );

  const restaurant = await getOrCreateRestaurant();
  const currency = invoice.currency ?? restaurant.currency;
  const amountCents = fromMajor(invoice.amountDue);
  if (amountCents <= 0) throw AppError.conflict('Invoice has no remaining balance');

  // Reuse an existing pending intent for the same balance so a retry never double-charges.
  const openPending = await PaymentModel.find({
    invoiceId: invoice._id,
    provider: 'stripe',
    status: 'pending',
  });
  const reusable = openPending.find(
    (p) => p.gatewayOrderId && fromMajor(p.amount) === amountCents,
  );
  if (reusable && reusable.gatewayOrderId) {
    const intent = await retrievePaymentIntent(reusable.gatewayOrderId);
    return {
      paymentId: String(reusable._id),
      provider: 'stripe',
      clientSecret: intent.client_secret,
      publishableKey: config.stripe.publishableKey || null,
      amount: invoice.amountDue,
      currency,
    };
  }

  const intent = await createPaymentIntent({
    amountCents,
    currency,
    idempotencyKey: `invoice_${invoice._id}_${amountCents}`,
    description: `Invoice ${invoice.invoiceNumber}`,
    receiptEmail: invoice.customerEmail,
    metadata: { invoiceId: String(invoice._id), orderId: String(invoice.orderId) },
  });

  // Retire stale pending intents for a different amount (e.g. tip changed).
  for (const stale of openPending)
    if (stale.gatewayOrderId !== intent.id) {
      stale.status = 'cancelled';
      await stale.save();
    }

  const payment = await PaymentModel.create({
    invoiceId: invoice._id,
    orderId: invoice.orderId,
    mode: 'card',
    provider: 'stripe',
    amount: invoice.amountDue,
    status: 'pending',
    gatewayOrderId: intent.id,
    cashierId: ctx.actorId ? new Types.ObjectId(ctx.actorId) : undefined,
  });

  await writeAuditLog({
    ...ctx,
    action: 'payment.card_intent',
    entity: 'Payment',
    entityId: String(payment._id),
    metadata: { invoiceId: String(invoice._id), paymentIntentId: intent.id, amountCents },
  });

  return {
    paymentId: String(payment._id),
    provider: 'stripe',
    clientSecret: intent.clientSecret,
    publishableKey: config.stripe.publishableKey || null,
    amount: invoice.amountDue,
    currency,
  };
}

/**
 * Process a verified Stripe webhook event. Idempotent: a replayed success is a no-op.
 * The controller has already verified the signature before calling this.
 */
export async function handleStripeWebhook(event: Stripe.Event) {
  if (event.type === 'payment_intent.succeeded') {
    const intent = event.data.object as Stripe.PaymentIntent;
    const payment = await PaymentModel.findOne({ gatewayOrderId: intent.id, provider: 'stripe' });
    if (!payment) return { ok: false, reason: 'payment not found' };
    if (payment.status === 'success' || payment.status === 'refunded')
      return { ok: true, idempotent: true };
    if (intent.amount_received !== fromMajor(payment.amount))
      throw AppError.badRequest('Gateway amount does not match the expected payment');
    payment.status = 'success';
    payment.gatewayPaymentId = intent.id;
    payment.txnRef =
      typeof intent.latest_charge === 'string' ? intent.latest_charge : intent.id;
    payment.receivedAt = new Date();
    payment.gatewayPayload = intent as unknown as Record<string, unknown>;
    await payment.save();
    await refreshInvoicePaymentState(payment.invoiceId);
    await maybeSettleOrder(payment.orderId, {});
    emitToStaff('order:updated', {
      id: String(payment.orderId),
      invoiceId: String(payment.invoiceId),
    });
    return { ok: true };
  }
  if (event.type === 'payment_intent.payment_failed') {
    const intent = event.data.object as Stripe.PaymentIntent;
    const payment = await PaymentModel.findOne({ gatewayOrderId: intent.id, provider: 'stripe' });
    if (!payment || payment.status !== 'pending') return { ok: true, idempotent: true };
    payment.status = 'failed';
    payment.gatewayPayload = intent as unknown as Record<string, unknown>;
    await payment.save();
    return { ok: true };
  }
  return { ok: true, ignored: event.type };
}

interface RazorpayWebhookEvent {
  event: string;
  payload?: {
    payment?: {
      entity?: {
        id: string;
        order_id: string;
        amount: number;
        status: string;
      };
    };
  };
}

export async function handleRazorpayWebhook(event: RazorpayWebhookEvent) {
  const entity = event.payload?.payment?.entity;
  if (!entity) return { ok: false, reason: 'no payment entity' };

  const payment = await PaymentModel.findOne({ gatewayOrderId: entity.order_id });
  if (!payment) return { ok: false, reason: 'payment not found' };
  if (payment.status === 'success' || payment.status === 'refunded')
    return { ok: true, idempotent: true };
  if (entity.amount !== Math.round(payment.amount * 100))
    throw AppError.badRequest('Gateway amount does not match the expected payment');

  if (event.event === 'payment.captured' || event.event === 'order.paid') {
    payment.status = 'success';
    payment.gatewayPaymentId = entity.id;
    payment.txnRef = entity.id;
    payment.receivedAt = new Date();
    payment.gatewayPayload = entity as unknown as Record<string, unknown>;
    await payment.save();
    await refreshInvoicePaymentState(payment.invoiceId);
    await maybeSettleOrder(payment.orderId, {});
    emitToStaff('order:settled', {
      orderId: String(payment.orderId),
      invoiceId: String(payment.invoiceId),
    });
  } else if (event.event === 'payment.failed') {
    payment.status = 'failed';
    payment.gatewayPayload = entity as unknown as Record<string, unknown>;
    await payment.save();
  }
  return { ok: true };
}

export interface RefundPaymentInput {
  idempotencyKey?: string;
  paymentId: string;
  amount: number;
  reason: string;
  method?: RefundMethod;
}

export async function refundPayment(input: RefundPaymentInput, ctx: ActorCtx) {
  if (!ctx.actorId) throw AppError.unauthorized();
  if (!input.idempotencyKey || !/^[a-zA-Z0-9_-]{16,100}$/.test(input.idempotencyKey))
    throw AppError.badRequest('A valid Idempotency-Key is required');
  const sameRequest = (refund: import('./refund.model').RefundDocument) => {
    if (
      String(refund.paymentId) !== input.paymentId ||
      refund.amount !== round2(input.amount) ||
      refund.reason !== input.reason ||
      (input.method && refund.method !== input.method) ||
      String(refund.approvedById) !== ctx.actorId
    )
      throw AppError.conflict('Idempotency key was already used for another refund');
    return refund;
  };

  // Gateway refunds hit the processor BEFORE we persist, using our idempotency key so a
  // retry reuses the same Stripe refund instead of moving money twice. Cash refunds skip this.
  let gatewayRefundId: string | undefined;
  {
    const already = await RefundModel.findOne({ idempotencyKey: input.idempotencyKey });
    if (already) return sameRequest(already);
    const payment = await PaymentModel.findById(input.paymentId);
    if (!payment) throw AppError.notFound('Payment not found');
    if (payment.status !== 'success')
      throw AppError.conflict('Only successful payments can be refunded');
    // Accounting lock: a refund against an invoice from a closed day is a retroactive
    // correction — block it until the period is reopened, before touching the processor.
    const lockInvoice = await InvoiceModel.findById(payment.invoiceId).select('issueDate');
    if (lockInvoice) {
      const { assertPeriodOpen } = await import('@modules/billing/dayClose.service');
      await assertPeriodOpen(lockInvoice.issueDate);
    }
    const method = input.method ?? (payment.mode === 'cash' ? 'cash' : 'gateway');
    // Approval limit: large refunds require the elevated `payment:refund_approve` permission.
    const restaurant = await getOrCreateRestaurant();
    const approvalLimit = restaurant.refundPolicy?.approvalLimit ?? 0;
    if (
      approvalLimit > 0 &&
      round2(input.amount) > approvalLimit &&
      !hasPermission(ctx.actorPermissions ?? [], 'payment:refund_approve')
    )
      throw AppError.forbidden(
        `This refund exceeds the ${approvalLimit} approval limit; a manager must approve it`,
      );
    if (method === 'wallet')
      throw new AppError(
        'SERVICE_UNAVAILABLE',
        'Refund processing for this provider is not configured. No refund has been recorded.',
      );
    if (method === 'gateway') {
      if (payment.provider !== 'stripe' || !stripeEnabled())
        throw new AppError(
          'SERVICE_UNAVAILABLE',
          'Refund processing for this provider is not configured. No refund has been recorded.',
        );
      const paymentIntentId = payment.gatewayPaymentId || payment.gatewayOrderId;
      if (!paymentIntentId)
        throw AppError.conflict('This payment has no gateway reference to refund');
      assertPaymentAmount(input.amount, round2(payment.amount - payment.refundedAmount));
      const { createRefund } = await import('@providers/stripe.provider');
      const result = await createRefund({
        paymentIntentId,
        amountCents: fromMajor(round2(input.amount)),
        idempotencyKey: `refund_${input.idempotencyKey}`,
        reason: input.reason,
      });
      gatewayRefundId = result.id;
    }
  }

  try {
    return await mongoose.connection.transaction(async (session) => {
      const existing = await RefundModel.findOne({ idempotencyKey: input.idempotencyKey }).session(
        session,
      );
      if (existing) return sameRequest(existing);
      const payment = await PaymentModel.findById(input.paymentId).session(session);
      if (!payment) throw AppError.notFound('Payment not found');
      if (payment.status !== 'success')
        throw AppError.conflict('Only successful payments can be refunded');
      const method = input.method ?? (payment.mode === 'cash' ? 'cash' : 'gateway');
      assertPaymentAmount(input.amount, round2(payment.amount - payment.refundedAmount));
      const invoice = await InvoiceModel.findById(payment.invoiceId).session(session);
      if (!invoice) throw AppError.notFound('Invoice not found');
      const cashSession =
        method === 'cash'
          ? await CashSessionModel.findOne({
              cashierId: new Types.ObjectId(ctx.actorId),
              status: 'open',
            }).session(session)
          : null;
      if (method === 'cash' && !cashSession)
        throw AppError.conflict('Open a cash session before issuing a cash refund');
      const [refund] = await RefundModel.create(
        [
          {
            invoiceId: payment.invoiceId,
            paymentId: payment._id,
            amount: round2(input.amount),
            reason: input.reason,
            method,
            status: 'processed',
            idempotencyKey: input.idempotencyKey,
            approvedById: new Types.ObjectId(ctx.actorId),
            cashSessionId: cashSession?._id,
            gatewayRefundId,
            processedAt: new Date(),
          },
        ],
        { session },
      );
      payment.refundedAmount = round2(payment.refundedAmount + input.amount);
      if (Math.round(payment.refundedAmount * 100) >= Math.round(payment.amount * 100))
        payment.status = 'refunded';
      await payment.save({ session });
      const payments = await PaymentModel.find({
        invoiceId: invoice._id,
        status: { $in: ['success', 'refunded'] },
      }).session(session);
      Object.assign(invoice, paymentBalance(invoice.grand + (invoice.tip || 0), payments));
      await invoice.save({ session });
      // A fully refunded invoice releases the order's promotions (loyalty, coupon, discount).
      if (invoice.paymentStatus === 'refunded') {
        const { reverseOrderPromotions } = await import('@modules/promotions/promotions.service');
        await reverseOrderPromotions(invoice.orderId, ctx.actorId, session);
      }
      if (cashSession)
        await CashSessionModel.updateOne(
          { _id: cashSession._id },
          { $inc: { expectedCash: -input.amount } },
          { session },
        );
      await AuditLogModel.create(
        [
          {
            ...ctx,
            action: 'payment.refund',
            entity: 'Payment',
            entityId: String(payment._id),
            at: new Date(),
            metadata: {
              amount: input.amount,
              reason: input.reason,
              refundId: String(refund._id),
              method,
            },
          },
        ],
        { session },
      );
      return refund;
    });
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    const existing = await RefundModel.findOne({ idempotencyKey: input.idempotencyKey });
    if (!existing) throw error;
    return sameRequest(existing);
  }
}

export interface ListPaymentsOpts {
  invoiceId?: string;
  orderId?: string;
  cashSessionId?: string;
  mode?: PaymentMode;
  status?: 'pending' | 'success' | 'failed' | 'refunded' | 'cancelled';
  from?: Date;
  to?: Date;
  page?: number;
  limit?: number;
}

export async function listPayments(opts: ListPaymentsOpts) {
  const page = Math.max(1, opts.page ?? 1);
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  const filter: Record<string, unknown> = {};
  if (opts.invoiceId) filter.invoiceId = new Types.ObjectId(opts.invoiceId);
  if (opts.orderId) filter.orderId = new Types.ObjectId(opts.orderId);
  if (opts.cashSessionId) filter.cashSessionId = new Types.ObjectId(opts.cashSessionId);
  if (opts.mode) filter.mode = opts.mode;
  if (opts.status) filter.status = opts.status;
  if (opts.from || opts.to) {
    filter.createdAt = {
      ...(opts.from ? { $gte: opts.from } : {}),
      ...(opts.to ? { $lte: opts.to } : {}),
    };
  }
  const [items, total] = await Promise.all([
    PaymentModel.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    PaymentModel.countDocuments(filter),
  ]);
  return { items, meta: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 } };
}
