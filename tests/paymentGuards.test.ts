import { assertPaymentAmount } from '../src/modules/payments/paymentGuards';
test('valid partial and exact payments', () => {
  expect(() => assertPaymentAmount(1.01, 10)).not.toThrow();
  expect(() => assertPaymentAmount(10, 10)).not.toThrow();
});
test('rejects overpayment, sub-cent amounts and non-finite input', () => {
  for (const amount of [11, 0, -1, .001, 1.001, NaN, Infinity]) expect(() => assertPaymentAmount(amount, 10)).toThrow();
});
