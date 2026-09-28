import { AppError } from '@utils/AppError';
export function assertPaymentAmount(amount: number, due: number) {
  if (
    !Number.isFinite(amount) ||
    !Number.isFinite(due) ||
    amount <= 0 ||
    Math.round(amount * 100) === 0
  )
    throw AppError.badRequest('Payment amount must be at least one cent');
  if (Math.abs(amount * 100 - Math.round(amount * 100)) > 0.00001)
    throw AppError.badRequest('Payment amount must have at most two decimal places');
  if (Math.round(amount * 100) > Math.round(due * 100))
    throw AppError.badRequest('Payment exceeds the remaining balance');
}
