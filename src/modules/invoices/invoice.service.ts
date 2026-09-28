import { createHash } from 'crypto';
import { paymentBalance } from '@modules/payments/paymentBalance';
import mongoose, { Types, FilterQuery } from 'mongoose';
import { AuditLogModel } from '@modules/audit/auditLog.model';
import { InvoiceModel, InvoiceDocument, InvoiceLineItem } from './invoice.model';
import { OrderModel } from '@modules/orders/order.model';
import { TableModel } from '@modules/tables/table.model';
import { AppError } from '@utils/AppError';
import { writeAuditLog } from '@modules/audit/audit.service';
import { getOrCreateRestaurant } from '@modules/restaurant/restaurant.service';
import { computeTotals } from '@modules/orders/pricing';
import { nextInvoiceNumber } from './invoiceNumbering';
import { moneyToWords } from '@utils/numberToWords';

interface ActorCtx {
  actorId?: string;
  actorEmail?: string;
  actorRole?: string;
  actorName?: string;
}

function buildLineItems(
  order: {
    items: Array<{
      _id: Types.ObjectId;
      name: string;
      variantName?: string;
      qty: number;
      basePrice: number;
      modifiers: Array<{ priceDelta: number }>;
      lineTotal: number;
      status: string;
    }>;
  },
  itemTaxRates: Array<{ name: string; type: string; rate: number }>,
): InvoiceLineItem[] {
  return order.items
    .filter((it) => it.status !== 'cancelled')
    .map((it) => {
      const modifierTotal = it.modifiers.reduce((s, m) => s + (m.priceDelta || 0), 0) * it.qty;
      const lineSubtotal = round2(it.basePrice * it.qty + modifierTotal);
      // Tax breakup is computed at invoice-level (not per line) for v1 — keep here as zero
      const taxBreakup = itemTaxRates.map((t) => ({ ...t, amount: 0 }));
      return {
        orderItemId: it._id,
        name: it.name,
        variantName: it.variantName,
        qty: it.qty,
        unitPrice: it.basePrice,
        modifierTotal: round2(modifierTotal),
        lineSubtotal,
        taxBreakup,
        lineTotal: round2(it.lineTotal),
      };
    });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface GenerateInvoiceInput {
  orderId: string;
  discount?: number;
  discountId?: string;
  couponCode?: string;
  loyaltyPoints?: number;
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
  customerGstin?: string;
}

export async function generateInvoiceForOrder(input: GenerateInvoiceInput, ctx: ActorCtx) {
  const requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const restaurant = await getOrCreateRestaurant();
  return mongoose.connection.transaction(async (session) => {
    const logAudit = (entry: Parameters<typeof writeAuditLog>[0]) =>
      AuditLogModel.create([{ ...entry, at: new Date() }], { session });
    const order = await OrderModel.findById(input.orderId).session(session);
    if (!order) throw AppError.notFound('Order not found');
    if (order.status === 'cancelled') throw AppError.conflict('Cannot bill a cancelled order');
    const existing = await InvoiceModel.findOne({ orderId: order._id, status: 'final' }).session(
      session,
    );
    const repricing =
      input.discount !== undefined ||
      !!input.discountId ||
      !!input.couponCode ||
      !!input.loyaltyPoints;
    if (existing && (!repricing || existing.generationRequestHash === requestHash)) return existing;
    if (order.status === 'settled')
      throw AppError.conflict('Cannot create or reprice a settled order');
    if ((order.currency ?? 'INR') !== restaurant.currency)
      throw AppError.conflict(
        'Order currency differs from current restaurant settings; review historical data before billing',
      );
    if (
      existing &&
      (existing.amountPaid > 0 ||
        existing.amountRefunded > 0 ||
        existing.paymentStatus !== 'unpaid')
    )
      throw AppError.conflict('An invoice with payments or refunds cannot be repriced');
    const { PaymentModel } = await import('@modules/payments/payment.model');
    if (
      existing &&
      (await PaymentModel.exists({ invoiceId: existing._id, status: 'pending' }).session(session))
    )
      throw AppError.conflict('Resolve pending payments before repricing');
    if (repricing && (existing?.promotions || order.couponCode || order.appliedBundles?.length))
      throw AppError.conflict(
        'This order already has a promotion. Resolve its existing promotion before changing discounts.',
      );
    if (existing && (input.discountId || input.couponCode || input.loyaltyPoints))
      throw AppError.conflict('Apply coupons or loyalty when first creating the invoice');
    order.financialVersion = (order.financialVersion ?? 0) + 1;
    // Compute base totals first so we know the order subtotal, then apply promotions
    // on top to determine a single combined "discount" value that pricing.ts consumes.

    let promotionsBreakdown:
      | {
          discount?: { id: string; name: string; amount: number };
          coupon?: { id: string; code: string; amount: number };
          loyalty?: { pointsRedeemed: number; amount: number };
          totalDiscount: number;
        }
      | undefined;
    let loyaltyCommitCtx: { pointsToCommit: number } | undefined;
    let combinedDiscount = input.discount ?? order.totals.discount ?? 0;

    if (input.discountId || input.couponCode || input.loyaltyPoints) {
      // Compute line totals once so the promotions service has accurate amounts.
      computeTotals({ items: order.items, restaurant, discount: 0 });
      const { applyPromotions } = await import('@modules/promotions/promotions.service');
      const result = await applyPromotions(
        order,
        {
          discountId: input.discountId,
          couponCode: input.couponCode,
          loyaltyPoints: input.loyaltyPoints,
        },
        session,
      );
      promotionsBreakdown = result.applied;
      loyaltyCommitCtx = result.loyaltyContext;
      combinedDiscount = round2(combinedDiscount + result.applied.totalDiscount);
    }

    const baseSubtotal = round2(order.totals.subtotal + order.totals.modifierTotal);
    if (
      !Number.isFinite(combinedDiscount) ||
      combinedDiscount < 0 ||
      combinedDiscount > baseSubtotal
    )
      throw AppError.badRequest('Discount exceeds the bill subtotal');
    const totals = repricing
      ? computeTotals({
          items: order.items,
          restaurant,
          discount: combinedDiscount,
        })
      : order.totals;
    order.totals = totals;
    await order.save({ session });

    if (existing && existing.paymentStatus !== 'paid') {
      existing.subtotal = totals.subtotal;
      existing.modifierTotal = totals.modifierTotal;
      existing.discount = totals.discount;
      existing.serviceCharge = totals.serviceCharge;
      existing.tax = totals.tax;
      existing.taxBreakup = totals.taxBreakup;
      existing.roundOff = totals.roundOff;
      existing.grand = totals.grand;
      existing.amountDue = round2(totals.grand + (existing.tip || 0) - existing.amountPaid);
      existing.amountInWords = moneyToWords(
        totals.grand + (existing.tip || 0),
        existing.currency ?? 'INR',
      );
      existing.lineItems = buildLineItems(
        order,
        totals.taxBreakup.map((t) => ({ name: t.name, type: t.type, rate: t.rate })),
      );
      if (input.customerName !== undefined) existing.customerName = input.customerName;
      if (input.customerPhone !== undefined) existing.customerPhone = input.customerPhone;
      if (input.customerEmail !== undefined) existing.customerEmail = input.customerEmail;
      if (input.customerGstin !== undefined) existing.customerGstin = input.customerGstin;
      existing.generationRequestHash = requestHash;
      existing.splitMode = 'none';
      existing.splits = [];
      await existing.save({ session });
      await logAudit({
        ...ctx,
        action: 'invoice.recompute',
        entity: 'Invoice',
        entityId: String(existing._id),
        metadata: { orderId: String(order._id) },
      });
      return existing;
    }

    const table = order.tableId
      ? await TableModel.findById(order.tableId).session(session).lean()
      : null;
    const invoiceNumber = await nextInvoiceNumber();

    const invoice = new InvoiceModel({
      generationRequestHash: requestHash,
      invoiceNumber,
      currency: restaurant.currency,
      timeZone: restaurant.timeZone,
      orderId: order._id,
      orderNumberSnapshot: order.orderNumber,
      issueDate: new Date(),
      billedAt: new Date(),
      cashierId: ctx.actorId ? new Types.ObjectId(ctx.actorId) : undefined,
      cashierName: ctx.actorName ?? ctx.actorEmail,

      customerName: input.customerName ?? order.guestName,
      customerPhone: input.customerPhone ?? order.guestPhone,
      customerEmail: input.customerEmail,
      customerGstin: input.customerGstin,
      tableNumber: table?.number,
      channel: order.channel,

      restaurantSnapshot: {
        name: restaurant.brand.name,
        gstin: restaurant.tax.gstin,
        fssai: restaurant.receipt.fssaiLicense,
        address: restaurant.brand.address,
        contactPhone: restaurant.brand.contactPhone,
        contactEmail: restaurant.brand.contactEmail,
        brandColor: restaurant.brand.brandColor,
        logoUrl: restaurant.brand.logoUrl,
        headerLines: restaurant.receipt.headerLines,
        footerLines: restaurant.receipt.footerLines,
      },

      lineItems: buildLineItems(
        order,
        totals.taxBreakup.map((t) => ({ name: t.name, type: t.type, rate: t.rate })),
      ),

      subtotal: totals.subtotal,
      modifierTotal: totals.modifierTotal,
      discount: totals.discount,
      serviceCharge: totals.serviceCharge,
      taxBreakup: totals.taxBreakup,
      tax: totals.tax,
      roundOff: totals.roundOff,
      grand: totals.grand,
      amountInWords: moneyToWords(totals.grand, restaurant.currency),

      amountPaid: 0,
      amountDue: totals.grand,
      paymentStatus: 'unpaid',

      splitMode: 'none',
      status: 'final',
      promotions: promotionsBreakdown
        ? {
            discount: promotionsBreakdown.discount,
            coupon: promotionsBreakdown.coupon,
            loyalty: promotionsBreakdown.loyalty,
          }
        : undefined,
    });

    await invoice.save({ session });

    // Promotions and the invoice commit in the same transaction.
    if (promotionsBreakdown) {
      const { commitPromotions } = await import('@modules/promotions/promotions.service');
      await commitPromotions(promotionsBreakdown, order, loyaltyCommitCtx, ctx.actorId, session);
      if (input.couponCode) order.couponCode = promotionsBreakdown.coupon?.code;
      await order.save({ session });
    }

    await logAudit({
      ...ctx,
      action: 'invoice.create',
      entity: 'Invoice',
      entityId: String(invoice._id),
      metadata: {
        orderId: String(order._id),
        invoiceNumber,
        grand: invoice.grand,
        promotions: promotionsBreakdown
          ? {
              discount: promotionsBreakdown.discount?.amount,
              coupon: promotionsBreakdown.coupon?.code,
              loyaltyPoints: promotionsBreakdown.loyalty?.pointsRedeemed,
            }
          : undefined,
      },
    });

    return invoice;
  });
}

export async function initiateGuestPayment(
  orderId: string,
  tipInput?: { amount?: number; percent?: number },
) {
  const restaurant = await getOrCreateRestaurant();
  const { config } = await import('@config/index');
  const useStripe = restaurant.currency !== 'INR';
  if (useStripe) {
    const { stripeEnabled } = await import('@providers/stripe.provider');
    if (!stripeEnabled())
      throw new AppError(
        'SERVICE_UNAVAILABLE',
        'Online payment is not configured. No payment has been initiated.',
      );
  } else if (!config.razorpay.enabled) {
    throw new AppError(
      'SERVICE_UNAVAILABLE',
      'Online payment is not configured. No payment has been initiated.',
    );
  }
  const order = await OrderModel.findById(orderId);
  if (!order) throw AppError.notFound('Order not found');
  if (['settled', 'cancelled'].includes(order.status)) {
    throw AppError.conflict(`Cannot pay — order is ${order.status}`);
  }

  let invoice = await generateInvoiceForOrder(
    { orderId },
    { actorName: `Guest:${order.guestPhone || order.guestName || 'anonymous'}` },
  );

  // Add tip if provided
  let finalAmount = invoice.grand;
  if (tipInput) {
    const tipAmount =
      tipInput.amount ?? (tipInput.percent ? round2((invoice.grand * tipInput.percent) / 100) : 0);
    if (tipAmount > 0) {
      invoice.tip = tipAmount;
      finalAmount = round2(invoice.grand + tipAmount);
      invoice.amountDue = finalAmount;
      await invoice.save();
    }
  }

  if (useStripe) {
    const { createCardPayment } = await import('@modules/payments/payment.service');
    const payment = await createCardPayment(
      { invoiceId: String(invoice._id) },
      { actorName: 'guest' },
    );
    return {
      invoiceId: String(invoice._id),
      invoiceNumber: invoice.invoiceNumber,
      amountDue: finalAmount,
      ...payment,
    };
  }

  const { createUpiQrPayment } = await import('@modules/payments/payment.service');
  const payment = await createUpiQrPayment(
    { invoiceId: String(invoice._id) },
    { actorName: 'guest' },
  );

  return {
    invoiceId: String(invoice._id),
    invoiceNumber: invoice.invoiceNumber,
    amountDue: finalAmount,
    ...payment,
  };
}

export interface SplitInput {
  mode: 'equal' | 'item' | 'custom';
  splits?: Array<{ label: string; amount?: number; orderItemIds?: string[] }>;
  equalCount?: number;
}

export async function splitInvoice(invoiceId: string, input: SplitInput, ctx: ActorCtx) {
  return mongoose.connection.transaction(async (session) => {
    const invoice = await InvoiceModel.findById(invoiceId).session(session);
    if (!invoice) throw AppError.notFound('Invoice not found');
    if (
      invoice.status !== 'final' ||
      invoice.paymentStatus !== 'unpaid' ||
      invoice.amountPaid > 0 ||
      invoice.amountRefunded > 0
    )
      throw AppError.conflict('Only an unpaid final invoice can be split');
    const { PaymentModel } = await import('@modules/payments/payment.model');
    if (await PaymentModel.exists({ invoiceId: invoice._id, status: 'pending' }).session(session))
      throw AppError.conflict('Resolve pending payments before splitting');
    const payable = Math.round((invoice.grand + (invoice.tip || 0)) * 100);
    const splits: InvoiceDocument['splits'] = [];
    const add = (label: string, cents: number, ids: string[] = []) => {
      if (!Number.isSafeInteger(cents) || cents <= 0)
        throw AppError.badRequest('Each split must be at least one cent');
      splits.push({
        _id: new Types.ObjectId(),
        label,
        amount: cents / 100,
        orderItemIds: ids.map((id) => new Types.ObjectId(id)),
        paidAmount: 0,
        status: 'unpaid',
      });
    };
    if (input.mode === 'equal') {
      const count = input.equalCount ?? 2;
      if (!Number.isInteger(count) || count < 2 || count > 20)
        throw AppError.badRequest('Choose 2–20 splits');
      const each = Math.floor(payable / count),
        extra = payable % count;
      for (let i = 0; i < count; i++) add(`Guest ${i + 1}`, each + (i < extra ? 1 : 0));
    } else if (input.mode === 'custom') {
      if (!input.splits?.length) throw AppError.badRequest('Provide split amounts');
      for (const split of input.splits) {
        const value = split.amount;
        if (value === undefined || Math.abs(value * 100 - Math.round(value * 100)) > 0.00001)
          throw AppError.badRequest('Use amounts with at most two decimals');
        add(split.label, Math.round(value * 100));
      }
    } else if (input.mode === 'item') {
      if (!input.splits?.length) throw AppError.badRequest('Assign items to each guest');
      const seen = new Set<string>();
      const weights: number[] = [];
      for (const split of input.splits) {
        if (!split.orderItemIds?.length)
          throw AppError.badRequest('Each guest needs at least one item');
        let weight = 0;
        for (const id of split.orderItemIds) {
          if (seen.has(id)) throw AppError.badRequest('An item was assigned twice');
          seen.add(id);
          const item = invoice.lineItems.find((l) => String(l.orderItemId) === id);
          if (!item) throw AppError.badRequest('Item is not on this invoice');
          weight += Math.round(item.lineSubtotal * 100);
        }
        weights.push(weight);
      }
      if (invoice.lineItems.some((l) => !l.orderItemId || !seen.has(String(l.orderItemId))))
        throw AppError.badRequest('Assign every invoice item to a guest');
      const sum = weights.reduce((s, w) => s + w, 0);
      if (!sum) throw AppError.badRequest('Cannot distribute a zero-value invoice');
      const allocated = weights.map((w) => Math.floor((payable * w) / sum));
      let remainder = payable - allocated.reduce((s, n) => s + n, 0);
      const ranked = weights
        .map((w, i) => ({ i, fraction: (payable * w) % sum }))
        .sort((a, b) => b.fraction - a.fraction || a.i - b.i);
      for (const entry of ranked) {
        if (remainder-- <= 0) break;
        allocated[entry.i] += 1;
      }
      input.splits.forEach((split, i) => add(split.label, allocated[i], split.orderItemIds));
    }
    if (splits.reduce((sum, s) => sum + Math.round(s.amount * 100), 0) !== payable)
      throw AppError.badRequest('Split amounts must exactly equal the invoice total including tip');
    invoice.splitMode = input.mode;
    invoice.splits = splits;
    await invoice.save({ session });
    await AuditLogModel.create(
      [
        {
          ...ctx,
          action: 'invoice.split',
          entity: 'Invoice',
          entityId: invoiceId,
          metadata: { mode: input.mode, count: splits.length, payableCents: payable },
          at: new Date(),
        },
      ],
      { session },
    );
    return invoice;
  });
}

export async function applyDiscount(invoiceId: string, amount: number, ctx: ActorCtx) {
  const invoice = await InvoiceModel.findById(invoiceId);
  if (!invoice) throw AppError.notFound('Invoice not found');
  if (invoice.status !== 'final') throw AppError.conflict('Invoice is void');
  if (invoice.paymentStatus === 'paid') throw AppError.conflict('Invoice already paid');
  if (amount < 0) throw AppError.badRequest('Discount must be non-negative');
  if (amount > invoice.subtotal + invoice.modifierTotal) {
    throw AppError.badRequest('Discount exceeds subtotal');
  }

  // Recompute totals using updated discount via the order
  const order = await OrderModel.findById(invoice.orderId);
  if (!order) throw AppError.notFound('Underlying order missing');
  return generateInvoiceForOrder({ orderId: String(order._id), discount: amount }, ctx);
}

/**
 * Change promotions after ordering: clear the coupon/discount/loyalty applied to an
 * unpaid invoice, release what they consumed, and reprice at no discount. The caller can
 * then apply a new promotion via generateInvoiceForOrder. Blocked once money has moved.
 */
export async function removeInvoicePromotions(invoiceId: string, ctx: ActorCtx) {
  const restaurant = await getOrCreateRestaurant();
  return mongoose.connection.transaction(async (session) => {
    const invoice = await InvoiceModel.findById(invoiceId).session(session);
    if (!invoice) throw AppError.notFound('Invoice not found');
    if (invoice.status !== 'final') throw AppError.conflict('Invoice is void');
    if (invoice.paymentStatus !== 'unpaid' || invoice.amountPaid > 0 || invoice.amountRefunded > 0)
      throw AppError.conflict('Only an unpaid invoice can have its promotions changed');
    if (invoice.splits.length)
      throw AppError.conflict('Remove the split before changing promotions');
    const { PaymentModel } = await import('@modules/payments/payment.model');
    if (await PaymentModel.exists({ invoiceId: invoice._id, status: 'pending' }).session(session))
      throw AppError.conflict('Resolve pending payments before changing promotions');

    const order = await OrderModel.findById(invoice.orderId).session(session);
    if (!order) throw AppError.notFound('Underlying order missing');

    const hadPromotion = Boolean(
      invoice.promotions ||
        order.couponCode ||
        order.appliedBundles?.length ||
        (invoice.discount ?? 0) > 0,
    );
    if (!hadPromotion) return invoice;

    // Release the coupon usage, discount usage, and redeemed loyalty this order consumed.
    const { reverseOrderPromotions } = await import('@modules/promotions/promotions.service');
    await reverseOrderPromotions(order._id, ctx.actorId, session);

    // Reprice at no discount.
    const totals = computeTotals({ items: order.items, restaurant, discount: 0 });
    order.totals = totals;
    order.couponCode = undefined;
    order.appliedBundles = [];
    order.financialVersion = (order.financialVersion ?? 0) + 1;
    await order.save({ session });

    invoice.subtotal = totals.subtotal;
    invoice.modifierTotal = totals.modifierTotal;
    invoice.discount = totals.discount;
    invoice.serviceCharge = totals.serviceCharge;
    invoice.tax = totals.tax;
    invoice.taxBreakup = totals.taxBreakup;
    invoice.roundOff = totals.roundOff;
    invoice.grand = totals.grand;
    invoice.amountDue = round2(totals.grand + (invoice.tip || 0));
    invoice.amountInWords = moneyToWords(
      totals.grand + (invoice.tip || 0),
      invoice.currency ?? 'INR',
    );
    invoice.set('promotions', undefined);
    invoice.markModified('promotions');
    invoice.lineItems = buildLineItems(
      order,
      totals.taxBreakup.map((t) => ({ name: t.name, type: t.type, rate: t.rate })),
    );
    await invoice.save({ session });

    await AuditLogModel.create(
      [
        {
          ...ctx,
          action: 'invoice.promotions_cleared',
          entity: 'Invoice',
          entityId: String(invoice._id),
          metadata: { orderId: String(order._id) },
          at: new Date(),
        },
      ],
      { session },
    );
    return invoice;
  });
}

export async function voidInvoice(invoiceId: string, reason: string, ctx: ActorCtx) {
  return mongoose.connection.transaction(async (session) => {
    const invoice = await InvoiceModel.findById(invoiceId).session(session);
    if (!invoice) throw AppError.notFound('Invoice not found');
    if (invoice.status === 'void') throw AppError.badRequest('Already void');
    // Accounting lock: cannot void an invoice from a closed business day.
    const { assertPeriodOpen } = await import('@modules/billing/dayClose.service');
    await assertPeriodOpen(invoice.issueDate, session);
    const { PaymentModel } = await import('@modules/payments/payment.model');
    const payments = await PaymentModel.find({ invoiceId: invoice._id }).session(session);
    const balance = paymentBalance(invoice.grand + (invoice.tip || 0), payments);
    if (balance.amountPaid > 0 || payments.some((payment) => payment.status === 'pending'))
      throw AppError.conflict('Resolve pending payments and refund collected money before voiding');
    invoice.status = 'void';
    invoice.voidReason = reason;
    invoice.voidedAt = new Date();
    invoice.voidedById = ctx.actorId ? new Types.ObjectId(ctx.actorId) : undefined;
    await invoice.save({ session });
    // Promotions consumed at billing (coupon/discount usage, redeemed loyalty points) are
    // released when the invoice is voided so they do not stay spent on a cancelled bill.
    const { reverseOrderPromotions } = await import('@modules/promotions/promotions.service');
    await reverseOrderPromotions(invoice.orderId, ctx.actorId, session);
    await AuditLogModel.create(
      [
        {
          ...ctx,
          action: 'invoice.void',
          entity: 'Invoice',
          entityId: String(invoice._id),
          at: new Date(),
          metadata: { reason },
        },
      ],
      { session },
    );
    return invoice;
  });
}

export interface ListInvoicesOpts {
  paymentStatus?: 'unpaid' | 'partial' | 'paid' | 'refunded';
  status?: 'final' | 'void';
  channel?: 'dine_in' | 'window' | 'assisted';
  from?: Date;
  to?: Date;
  q?: string;
  page?: number;
  limit?: number;
}

export async function listInvoices(opts: ListInvoicesOpts) {
  const page = Math.max(1, opts.page ?? 1);
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  const filter: FilterQuery<InvoiceDocument> = {};
  if (opts.paymentStatus) filter.paymentStatus = opts.paymentStatus;
  if (opts.status) filter.status = opts.status;
  if (opts.channel) filter.channel = opts.channel;
  if (opts.from || opts.to) {
    filter.issueDate = {
      ...(opts.from ? { $gte: opts.from } : {}),
      ...(opts.to ? { $lte: opts.to } : {}),
    };
  }
  if (opts.q) {
    const rx = new RegExp(opts.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ invoiceNumber: rx }, { customerPhone: rx }, { customerName: rx }];
  }
  const [items, total] = await Promise.all([
    InvoiceModel.find(filter)
      .sort({ issueDate: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    InvoiceModel.countDocuments(filter),
  ]);
  return { items, meta: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 } };
}

export async function getInvoice(id: string) {
  const inv = await InvoiceModel.findById(id).lean();
  if (!inv) throw AppError.notFound('Invoice not found');
  return inv;
}

// Called by payment service when payments settle — refreshes amountPaid/Due/Status.
export async function refreshInvoicePaymentState(invoiceId: Types.ObjectId | string) {
  const invoice = await InvoiceModel.findById(invoiceId);
  if (!invoice) return null;
  const { PaymentModel } = await import('@modules/payments/payment.model');
  const payments = await PaymentModel.find({
    invoiceId: invoice._id,
    status: { $in: ['success', 'refunded'] },
  }).lean();
  Object.assign(invoice, paymentBalance(invoice.grand + (invoice.tip || 0), payments));
  await invoice.save();
  return invoice;
}

export async function setInvoiceTip(id: string, tip: number, ctx: ActorCtx) {
  if (
    !Number.isFinite(tip) ||
    tip < 0 ||
    tip > 100000 ||
    Math.abs(tip * 100 - Math.round(tip * 100)) > 0.00001
  )
    throw AppError.badRequest('Enter a nonnegative tip with at most two decimals');
  return mongoose.connection.transaction(async (session) => {
    const invoice = await InvoiceModel.findById(id).session(session);
    if (!invoice) throw AppError.notFound('Invoice not found');
    if (
      invoice.status !== 'final' ||
      invoice.paymentStatus !== 'unpaid' ||
      invoice.amountPaid > 0 ||
      invoice.amountRefunded > 0
    )
      throw AppError.conflict('Set the tip before collecting payment');
    if (invoice.splits.length) throw AppError.conflict('Set the tip before splitting the invoice');
    const { PaymentModel } = await import('@modules/payments/payment.model');
    if (await PaymentModel.exists({ invoiceId: invoice._id, status: 'pending' }).session(session))
      throw AppError.conflict('Resolve pending payments before changing the tip');
    const previous = invoice.tip;
    invoice.tip = tip;
    invoice.amountDue = round2(invoice.grand + tip);
    invoice.amountInWords = moneyToWords(invoice.amountDue, invoice.currency ?? 'INR');
    await invoice.save({ session });
    await AuditLogModel.create(
      [
        {
          ...ctx,
          action: 'invoice.tip',
          entity: 'Invoice',
          entityId: id,
          metadata: { from: previous, to: tip },
          at: new Date(),
        },
      ],
      { session },
    );
    return invoice;
  });
}
