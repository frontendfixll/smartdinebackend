import type { Connection } from 'mongoose';
import { toMinorUnitsExact } from '@utils/money';

type RecordData = Record<string, any>;
const fields: Record<string, string[]> = {
  orders: [
    'totals.subtotal',
    'totals.modifierTotal',
    'totals.discount',
    'totals.serviceCharge',
    'totals.tax',
    'totals.roundOff',
    'totals.grand',
    'totals.taxBreakup.*.amount',
    'items.*.basePrice',
    'items.*.lineTotal',
    'items.*.modifiers.*.priceDelta',
    'appliedBundles.*.discount',
  ],
  invoices: [
    'subtotal',
    'modifierTotal',
    'discount',
    'serviceCharge',
    'tip',
    'tax',
    'roundOff',
    'grand',
    'amountPaid',
    'amountRefunded',
    'amountDue',
    'taxBreakup.*.amount',
    'lineItems.*.unitPrice',
    'lineItems.*.modifierTotal',
    'lineItems.*.lineSubtotal',
    'lineItems.*.lineTotal',
    'lineItems.*.taxBreakup.*.amount',
    'splits.*.amount',
    'splits.*.paidAmount',
    'promotions.discount.amount',
    'promotions.coupon.amount',
    'promotions.loyalty.amount',
  ],
  payments: ['amount', 'refundedAmount', 'cashTendered', 'changeReturned', 'tip'],
  refunds: ['amount'],
  cashsessions: ['openingFloat', 'expectedCash', 'actualCash', 'variance'],
};
function valuesAt(record: unknown, parts: string[], path = ''): Array<[string, unknown]> {
  if (!parts.length) return record === undefined ? [] : [[path, record]];
  const [head, ...tail] = parts;
  if (head === '*')
    return Array.isArray(record)
      ? record.flatMap((entry, i) => valuesAt(entry, tail, `${path}.${i}`))
      : [];
  return record && typeof record === 'object'
    ? valuesAt((record as RecordData)[head], tail, path ? `${path}.${head}` : head)
    : [];
}

/** Read-only: reports blockers before any monetary fields or currency meanings are changed. */
export async function auditMoneyStorage(connection: Connection, maxRecordsPerCollection = 50000) {
  const counts: Record<string, number> = {},
    issueCounts: Record<string, number> = {};
  const examples: Array<{ collection: string; id: string; path: string; code: string }> = [];
  const totals: Record<string, Record<string, string>> = {};
  const orders = new Map<string, RecordData>(),
    invoices = new Map<string, RecordData>();
  const captured = new Map<string, bigint>(),
    returned = new Map<string, bigint>(),
    refundByPayment = new Map<string, bigint>();
  const payments = new Map<string, RecordData>();
  let truncated = false;
  const issue = (collection: string, doc: RecordData, path: string, code: string) => {
    issueCounts[code] = (issueCounts[code] ?? 0) + 1;
    if (examples.length < 100) examples.push({ collection, id: String(doc._id), path, code });
  };
  const minor = (value: unknown): bigint | undefined => {
    try {
      return BigInt(toMinorUnitsExact(value));
    } catch {
      return undefined;
    }
  };
  const add = (map: Map<string, bigint>, key: string, amount: bigint | undefined) => {
    if (amount !== undefined) map.set(key, (map.get(key) ?? 0n) + amount);
  };
  const total = (collection: string, currency: string, value: unknown) => {
    const amount = minor(value);
    if (amount === undefined) return;
    totals[collection] ??= {};
    totals[collection][currency] = String(BigInt(totals[collection][currency] ?? '0') + amount);
  };
  for (const collection of ['orders', 'invoices', 'payments', 'refunds', 'cashsessions']) {
    counts[collection] = 0;
    const projection: Record<string, 1> = {
      _id: 1,
      currency: 1,
      orderId: 1,
      invoiceId: 1,
      paymentId: 1,
      status: 1,
      splitMode: 1,
    };
    for (const field of fields[collection]) projection[field.split('.*')[0]] = 1;
    const docs = connection
      .collection(collection)
      .find({}, { projection })
      .limit(maxRecordsPerCollection + 1);
    for await (const doc of docs) {
      if (++counts[collection] > maxRecordsPerCollection) {
        truncated = true;
        issue(collection, doc, '', 'SCAN_LIMIT');
        break;
      }
      for (const field of fields[collection])
        for (const [path, value] of valuesAt(doc, field.split('.'))) {
          try {
            toMinorUnitsExact(value);
          } catch (error) {
            issue(collection, doc, path, (error as Error).message);
          }
          if (
            typeof value === 'number' &&
            value < 0 &&
            !/(roundOff|variance|priceDelta|expectedCash)$/.test(path)
          )
            issue(collection, doc, path, 'NEGATIVE_AMOUNT');
        }
      const primary =
        collection === 'orders'
          ? doc.totals?.grand
          : collection === 'invoices'
            ? doc.grand
            : collection === 'cashsessions'
              ? doc.openingFloat
              : doc.amount;
      if (primary === undefined) issue(collection, doc, '', 'MISSING_PRIMARY_AMOUNT');
      if (collection === 'orders' || collection === 'invoices') {
        if (!doc.currency) issue(collection, doc, 'currency', 'CURRENCY_REVIEW_REQUIRED');
        else if (!['USD', 'INR'].includes(doc.currency))
          issue(collection, doc, 'currency', 'UNSUPPORTED_CURRENCY');
      }
      if (collection === 'orders') {
        orders.set(String(doc._id), { currency: doc.currency, grand: doc.totals?.grand });
        total(collection, doc.currency ?? 'UNSPECIFIED', primary);
      } else if (collection === 'invoices') {
        for (const balance of ['amountPaid', 'amountRefunded', 'amountDue'])
          if (doc[balance] === undefined) issue(collection, doc, balance, 'MISSING_BALANCE');
        const linked = orders.get(String(doc.orderId));
        if (!linked) issue(collection, doc, 'orderId', 'MISSING_ORDER');
        else if (linked.currency && doc.currency && linked.currency !== doc.currency)
          issue(collection, doc, 'currency', 'CURRENCY_CONFLICT');
        if (
          doc.status === 'final' &&
          linked &&
          minor(linked.grand) !== undefined &&
          minor(doc.grand) !== undefined &&
          minor(linked.grand) !== minor(doc.grand)
        )
          issue(collection, doc, 'grand', 'ORDER_INVOICE_MISMATCH');
        if (doc.splitMode && doc.splitMode !== 'none') {
          const splitAmounts = (doc.splits ?? []).map((s: RecordData) => minor(s.amount));
          if (
            !splitAmounts.length ||
            splitAmounts.some((v: bigint | undefined) => v === undefined) ||
            (minor(doc.grand) !== undefined &&
              minor(doc.tip ?? 0) !== undefined &&
              splitAmounts.reduce((s: bigint, v: bigint) => s + v, 0n) !==
                minor(doc.grand)! + minor(doc.tip ?? 0)!)
          )
            issue(collection, doc, 'splits', 'SPLIT_TOTAL_MISMATCH');
        }
        invoices.set(String(doc._id), {
          _id: doc._id,
          currency: doc.currency,
          orderId: doc.orderId,
          grand: doc.grand,
          tip: doc.tip,
          amountPaid: doc.amountPaid,
          amountRefunded: doc.amountRefunded,
          amountDue: doc.amountDue,
        });
        total(collection, doc.currency ?? 'UNSPECIFIED', primary);
      } else if (collection === 'payments') {
        const linked = invoices.get(String(doc.invoiceId));
        if (!linked) issue(collection, doc, 'invoiceId', 'MISSING_INVOICE');
        else if (String(doc.orderId) !== String(linked.orderId))
          issue(collection, doc, 'orderId', 'PAYMENT_ORDER_MISMATCH');
        if (['success', 'refunded'].includes(doc.status)) {
          add(captured, String(doc.invoiceId), minor(doc.amount));
          add(returned, String(doc.invoiceId), minor(doc.refundedAmount ?? 0));
          total(collection, linked?.currency ?? 'UNSPECIFIED', primary);
        }
        payments.set(String(doc._id), {
          _id: doc._id,
          invoiceId: doc.invoiceId,
          amount: doc.amount,
          refundedAmount: doc.refundedAmount,
        });
      } else if (collection === 'refunds') {
        const linked = payments.get(String(doc.paymentId));
        if (!linked) issue(collection, doc, 'paymentId', 'MISSING_PAYMENT');
        else if (String(linked.invoiceId) !== String(doc.invoiceId))
          issue(collection, doc, 'invoiceId', 'REFUND_INVOICE_MISMATCH');
        if (doc.status === 'processed') {
          add(refundByPayment, String(doc.paymentId), minor(doc.amount));
          total(
            collection,
            invoices.get(String(doc.invoiceId))?.currency ?? 'UNSPECIFIED',
            primary,
          );
        }
      } else {
        // Opening floats have no currency snapshot; linked tenders cannot establish their historical unit.
        issue(collection, doc, 'currency', 'CASH_CURRENCY_REVIEW_REQUIRED');
      }
    }
  }
  for (const [id, invoice] of invoices) {
    const grand = minor(invoice.grand),
      tip = minor(invoice.tip ?? 0),
      paid = minor(invoice.amountPaid),
      refunded = minor(invoice.amountRefunded),
      due = minor(invoice.amountDue);
    const gross = captured.get(id) ?? 0n,
      refunds = returned.get(id) ?? 0n;
    if (
      paid !== undefined &&
      refunded !== undefined &&
      (paid !== gross - refunds || refunded !== refunds)
    )
      issue('invoices', invoice, 'amountPaid', 'PAYMENT_BALANCE_MISMATCH');
    if (grand !== undefined && tip !== undefined && due !== undefined) {
      const owed = grand + tip - gross;
      if (due !== (owed > 0n ? owed : 0n))
        issue('invoices', invoice, 'amountDue', 'AMOUNT_DUE_MISMATCH');
      if (gross > grand + tip) issue('invoices', invoice, 'grand', 'OVERPAYMENT');
    }
  }
  for (const [id, payment] of payments) {
    const amount = minor(payment.amount),
      refund = minor(payment.refundedAmount ?? 0);
    if (refund !== undefined && refund !== (refundByPayment.get(id) ?? 0n))
      issue('payments', payment, 'refundedAmount', 'REFUND_BALANCE_MISMATCH');
    if (amount !== undefined && refund !== undefined && refund > amount)
      issue('payments', payment, 'refundedAmount', 'OVER_REFUND');
  }
  return {
    generatedAt: new Date().toISOString(),
    mode: 'read-only',
    counts,
    truncated,
    issueCounts,
    examples,
    totalsCents: totals,
    reconciled: !truncated && Object.keys(issueCounts).length === 0,
    readyForCutover: false,
    scope:
      'Order/invoice/payment/refund/cash preflight only. No data changed. Amount sums are integer-cent strings; currencies stay separate. Inventory unit costs, pricing configuration, promotions, customer aggregates and day-close snapshots require a separate precision/migration review. Run against a quiescent local clone; this scan is not a consistent live-database snapshot.',
  };
}
