import { paymentBalance } from '../src/modules/payments/paymentBalance';

test('balance includes tips and ignores pending or failed tenders', () => {
  expect(paymentBalance(11.2, [{ amount: 5, status: 'success' }, { amount: 50, status: 'pending' }, { amount: 50, status: 'failed' }]))
    .toEqual({ amountPaid: 5, amountRefunded: 0, amountDue: 6.2, paymentStatus: 'partial' });
});
test('partial and full refunds do not reopen the original invoice debt', () => {
  expect(paymentBalance(10, [{ amount: 10, refundedAmount: 3, status: 'success' }]))
    .toEqual({ amountPaid: 7, amountRefunded: 3, amountDue: 0, paymentStatus: 'paid' });
  expect(paymentBalance(10, [{ amount: 10, refundedAmount: 10, status: 'refunded' }]))
    .toEqual({ amountPaid: 0, amountRefunded: 10, amountDue: 0, paymentStatus: 'refunded' });
});
test('refund on a partially paid invoice preserves only the original unpaid portion', () => {
  expect(paymentBalance(10, [{ amount: 4, refundedAmount: 4, status: 'refunded' }]).amountDue).toBe(6);
});
