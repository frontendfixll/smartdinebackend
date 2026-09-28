import mongoose, { ClientSession } from 'mongoose';
import { OrderModel } from '@modules/orders/order.model';
import { InvoiceModel } from '@modules/invoices/invoice.model';
import { PaymentModel } from '@modules/payments/payment.model';
import { RefundModel } from '@modules/payments/refund.model';
import { CashSessionModel } from '@modules/cashSessions/cashSession.model';
import { AuditLogModel } from '@modules/audit/auditLog.model';
import { getOrCreateRestaurant } from '@modules/restaurant/restaurant.service';
import { pacificDateTime } from '@utils/pacificDateTime';
import { AppError } from '@utils/AppError';
import { DayCloseModel } from './dayClose.model';
interface ActorCtx {
  actorId?: string;
  actorEmail?: string;
  actorRole?: string;
  actorName?: string;
}
const round2 = (n: number) => Math.round(n * 100) / 100;
export function businessDate(value: Date | string = new Date()) {
  if (typeof value === 'string') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw AppError.badRequest('Use YYYY-MM-DD');
    pacificDateTime(value, '00:00');
    return value;
  }
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(value)
      .map((p) => [p.type, p.value]),
  );
  return `${p.year}-${p.month}-${p.day}`;
}
export async function buildDayClose(date: Date | string = new Date(), session?: ClientSession) {
  const day = businessDate(date),
    from = pacificDateTime(day, '00:00'),
    to = new Date(pacificDateTime(day, '23:59').getTime() + 59999);
  const range = { $gte: from, $lte: to };
  const currency = (await getOrCreateRestaurant()).currency;
  const currencyFilter = { $expr: { $eq: [{ $ifNull: ['$currency', 'INR'] }, currency] } };
  const orders = await OrderModel.find({ createdAt: range, ...currencyFilter })
    .session(session ?? null)
    .lean();
  const invoices = await InvoiceModel.find({ issueDate: range, ...currencyFilter })
    .session(session ?? null)
    .lean();
  const paymentRows = await PaymentModel.find({
    createdAt: range,
    status: { $in: ['success', 'refunded'] },
  })
    .session(session ?? null)
    .lean();
  const refundRows = await RefundModel.find({ processedAt: range, status: 'processed' })
    .session(session ?? null)
    .lean();
  const referenced = await InvoiceModel.find({
    _id: { $in: [...paymentRows.map((p) => p.invoiceId), ...refundRows.map((r) => r.invoiceId)] },
    ...currencyFilter,
  })
    .select('_id')
    .session(session ?? null)
    .lean();
  const ids = new Set(referenced.map((i) => String(i._id)));
  const payments = paymentRows.filter((p) => ids.has(String(p.invoiceId)));
  const refunds = refundRows.filter((r) => ids.has(String(r.invoiceId)));
  const openCashSessions = await CashSessionModel.find({ status: 'open', openedAt: { $lte: to } })
    .session(session ?? null)
    .lean();
  const unresolvedOrders = await OrderModel.countDocuments({
    createdAt: { $lte: to },
    status: { $nin: ['settled', 'cancelled'] },
  }).session(session ?? null);
  const unpaidInvoices = await InvoiceModel.countDocuments({
    status: 'final',
    issueDate: { $lte: to },
    amountDue: { $gt: 0 },
    ...currencyFilter,
  }).session(session ?? null);
  const pendingPayments = await PaymentModel.countDocuments({
    status: 'pending',
    createdAt: { $lte: to },
  }).session(session ?? null);
  const pendingRefunds = await RefundModel.countDocuments({
    status: 'pending',
    createdAt: { $lte: to },
  }).session(session ?? null);
  const final = invoices.filter((i) => i.status === 'final');
  const sum = (field: 'grand' | 'discount' | 'tax' | 'tip' | 'serviceCharge') =>
    round2(final.reduce((s, i) => s + (i[field] ?? 0), 0));
  const taxByType: Record<string, number> = {};
  for (const invoice of final)
    for (const t of invoice.taxBreakup)
      taxByType[t.name] = round2((taxByType[t.name] ?? 0) + t.amount);
  const byMode: Record<string, number> = {};
  for (const p of payments) byMode[p.mode] = round2((byMode[p.mode] ?? 0) + p.amount);
  const refundsByMethod: Record<string, number> = {};
  for (const r of refunds)
    refundsByMethod[r.method] = round2((refundsByMethod[r.method] ?? 0) + r.amount);
  const collected = round2(payments.reduce((s, p) => s + p.amount, 0)),
    refunded = round2(refunds.reduce((s, r) => s + r.amount, 0));
  const blockers = [
    ...(day >= businessDate() ? ['The Pacific business day must finish before closing'] : []),
    ...(unresolvedOrders ? [`${unresolvedOrders} orders remain open through this day`] : []),
    ...(unpaidInvoices ? [`${unpaidInvoices} invoices remain unpaid through this day`] : []),
    ...(pendingPayments ? [`${pendingPayments} payments are pending`] : []),
    ...(pendingRefunds ? [`${pendingRefunds} refunds are pending`] : []),
    ...(openCashSessions.length
      ? [`${openCashSessions.length} drawers opened through this day remain open`]
      : []),
  ];
  const itemTotals = new Map<string, { name: string; qty: number; revenue: number }>();
  for (const order of orders.filter((o) => o.status !== 'cancelled'))
    for (const item of order.items.filter((i) => i.status !== 'cancelled')) {
      const t = itemTotals.get(item.name) ?? { name: item.name, qty: 0, revenue: 0 };
      t.qty += item.qty;
      t.revenue = round2(t.revenue + item.lineTotal);
      itemTotals.set(item.name, t);
    }
  return {
    topItems: [...itemTotals.values()].sort((a, b) => b.qty - a.qty).slice(0, 10),
    date: day,
    currency,
    timeZone: 'America/Los_Angeles',
    range: { from, to },
    orderCounts: {
      total: orders.length,
      settled: orders.filter((o) => o.status === 'settled').length,
      cancelled: orders.filter((o) => o.status === 'cancelled').length,
      open: orders.filter((o) => !['settled', 'cancelled'].includes(o.status)).length,
    },
    sales: {
      gross: sum('grand'),
      discounts: sum('discount'),
      taxCollected: sum('tax'),
      tips: sum('tip'),
      serviceCharge: sum('serviceCharge'),
      taxByType,
      net: round2(sum('grand') - sum('tax') - sum('serviceCharge')),
      voids: invoices.filter((i) => i.status === 'void').length,
    },
    payments: {
      byMode,
      refundsByMethod,
      collected,
      refunds: refunded,
      total: round2(collected - refunded),
    },
    cashSessions: {
      openCount: openCashSessions.length,
      openSessions: openCashSessions.map((s) => ({
        id: String(s._id),
        cashierName: s.cashierName,
        openedAt: s.openedAt,
        expectedCash: s.expectedCash,
      })),
    },
    blockers,
    canClose: blockers.length === 0,
  };
}
/**
 * True when the Pacific business day of `when` is closed and locked (not reopened).
 * A locked day rejects retroactive financial corrections.
 */
export async function isBusinessDayClosed(when: Date, session?: ClientSession): Promise<boolean> {
  const day = businessDate(when);
  const currency = (await getOrCreateRestaurant()).currency;
  const record = await DayCloseModel.findOne({ businessDate: day, currency })
    .select('reopenedAt')
    .session(session ?? null)
    .lean();
  return Boolean(record && !record.reopenedAt);
}

/** Throw if `when` falls in a locked (closed, not reopened) business day. */
export async function assertPeriodOpen(when: Date, session?: ClientSession): Promise<void> {
  if (await isBusinessDayClosed(when, session))
    throw AppError.conflict(
      `The ${businessDate(when)} business day is closed. Reopen the period to make corrections.`,
    );
}

/** Reopen a closed day so corrections can be made; it must be closed again afterwards. */
export async function reopenDayClose(date: Date | string, reason: string, ctx: ActorCtx) {
  if (!ctx.actorId) throw AppError.unauthorized();
  if (!reason?.trim()) throw AppError.badRequest('A reason is required to reopen a closed day');
  const day = businessDate(date);
  const currency = (await getOrCreateRestaurant()).currency;
  return mongoose.connection.transaction(async (session) => {
    const record = await DayCloseModel.findOne({ businessDate: day, currency }).session(session);
    if (!record) throw AppError.notFound('No close record for this day');
    if (record.reopenedAt) throw AppError.conflict('This day is already reopen');
    record.reopenedAt = new Date();
    record.reopenedById = new mongoose.Types.ObjectId(ctx.actorId);
    record.reopenReason = reason.trim();
    await record.save({ session });
    await AuditLogModel.create(
      [
        {
          ...ctx,
          action: 'day.reopen',
          entity: 'DayClose',
          entityId: String(record._id),
          metadata: { date: day, currency, reason: reason.trim() },
          at: new Date(),
        },
      ],
      { session },
    );
    return record;
  });
}

export async function recordDayClose(date: Date | string, ctx: ActorCtx) {
  if (!ctx.actorId) throw AppError.unauthorized();
  const day = businessDate(date);
  const currency = (await getOrCreateRestaurant()).currency;
  try {
    return await mongoose.connection.transaction(async (session) => {
      const prior = await DayCloseModel.findOne({ businessDate: day, currency }).session(session);
      // A still-locked prior close is returned as-is; a reopened one is recomputed and re-locked.
      if (prior && !prior.reopenedAt) return prior;
      const summary = await buildDayClose(day, session);
      if (prior && prior.reopenedAt) {
        if (!summary.canClose)
          throw AppError.conflict('Resolve the day-close checklist first', {
            blockers: summary.blockers,
          });
        prior.summary = summary;
        prior.closedById = new mongoose.Types.ObjectId(ctx.actorId);
        prior.reopenedAt = undefined;
        prior.reopenedById = undefined;
        prior.reopenReason = undefined;
        await prior.save({ session });
        await AuditLogModel.create(
          [
            {
              ...ctx,
              action: 'day.close',
              entity: 'DayClose',
              entityId: String(prior._id),
              metadata: { date: day, currency, reclosed: true, gross: summary.sales.gross },
              at: new Date(),
            },
          ],
          { session },
        );
        return prior;
      }
      if (!summary.canClose)
        throw AppError.conflict('Resolve the day-close checklist first', {
          blockers: summary.blockers,
        });
      const [record] = await DayCloseModel.create(
        [{ businessDate: day, currency, closedById: ctx.actorId, summary }],
        { session },
      );
      await AuditLogModel.create(
        [
          {
            ...ctx,
            action: 'day.close',
            entity: 'DayClose',
            entityId: String(record._id),
            metadata: {
              date: day,
              currency,
              gross: summary.sales.gross,
              collections: summary.payments.total,
            },
            at: new Date(),
          },
        ],
        { session },
      );
      return record;
    });
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    const prior = await DayCloseModel.findOne({ businessDate: day, currency });
    if (!prior) throw error;
    return prior;
  }
}
