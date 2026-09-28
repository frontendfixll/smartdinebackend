import { fromMajor, subCents, sumCents, toMajor } from '@utils/money';

/** Refunds reduce retained revenue; they do not create a new debt for the guest. */
export function paymentBalance(
  payable: number,
  payments: ReadonlyArray<{ amount: number; refundedAmount?: number; status: string }>,
) {
  const captured = payments.filter((p) => p.status === 'success' || p.status === 'refunded');
  const grossCents = sumCents(captured.map((p) => fromMajor(p.amount)));
  const refundCents = sumCents(captured.map((p) => fromMajor(p.refundedAmount ?? 0)));
  const dueCents = Math.max(0, subCents(fromMajor(payable), grossCents));
  const paymentStatus: 'unpaid' | 'partial' | 'paid' | 'refunded' =
    grossCents === 0
      ? 'unpaid'
      : dueCents > 0
        ? 'partial'
        : refundCents >= grossCents
          ? 'refunded'
          : 'paid';
  return {
    amountPaid: toMajor(subCents(grossCents, refundCents)),
    amountRefunded: toMajor(refundCents),
    amountDue: toMajor(dueCents),
    paymentStatus,
  };
}
