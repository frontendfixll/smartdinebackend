import { createHash } from 'node:crypto';
import { Schema, model, ClientSession } from 'mongoose';
import { ZodError } from 'zod';
import { OrderModel, OrderDocument } from './order.model';
import { AppError, AppErrorCode } from '@utils/AppError';

// No TTL: forgetting a successful attempt would allow an old retry to place it twice.
const receiptSchema = new Schema(
  {
    _id: { type: String, required: true },
    requestHash: { type: String, required: true },
    operation: { type: String, required: true },
    state: { type: String, enum: ['completed', 'rejected'], required: true },
    orderId: { type: Schema.Types.ObjectId, ref: 'Order' },
    errorCode: String,
    errorMessage: String,
  },
  { timestamps: true },
);
export const OrderRequestModel = model('OrderRequest', receiptSchema);

export interface OrderRequest {
  _id: string;
  requestHash: string;
  operation: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export function orderRequest(
  key: unknown,
  scope: string,
  operation: string,
  payload: unknown,
): OrderRequest {
  if (
    typeof key !== 'string' ||
    !/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(key)
  )
    throw AppError.badRequest(
      'A random UUID v4 Idempotency-Key is required for this order request',
    );
  return {
    _id: hash(`${scope}:${key.toLowerCase()}`),
    requestHash: hash(canonical({ operation, payload })),
    operation,
  };
}

async function replay(attempt: OrderRequest): Promise<OrderDocument | null> {
  const receipt = await OrderRequestModel.findById(attempt._id).read('primary').lean();
  if (!receipt) return null;
  if (receipt.requestHash !== attempt.requestHash)
    throw AppError.conflict(
      'This checkout key belongs to a different request. Recover the original attempt.',
      { reason: 'IDEMPOTENCY_MISMATCH' },
    );
  if (receipt.state === 'rejected')
    throw new AppError(
      receipt.errorCode as AppErrorCode,
      receipt.errorMessage ?? 'Review this order before trying again',
      { orderRequestRejected: true },
    );
  const order = await OrderModel.findById(receipt.orderId).read('primary');
  if (!order)
    throw AppError.conflict(
      'The original order needs staff assistance. Do not place a replacement.',
      { reason: 'ORDER_UNAVAILABLE' },
    );
  return order;
}

/** Must run inside the same transaction as the order mutation. */
export async function completeOrderRequest(
  attempt: OrderRequest | undefined,
  orderId: unknown,
  session: ClientSession,
) {
  if (attempt)
    await OrderRequestModel.create([{ ...attempt, state: 'completed', orderId }], { session });
}

/** A durable terminal rejection also wins the key, so a rejected attempt can be edited safely. */
export async function runOrderRequest(
  attempt: OrderRequest,
  work: (attempt: OrderRequest) => Promise<OrderDocument>,
): Promise<OrderDocument> {
  const previous = await replay(attempt);
  if (previous) return previous;
  try {
    return await work(attempt);
  } catch (error) {
    // Includes races on the unique receipt _id and failures after a successful commit.
    const committed = await replay(attempt);
    if (committed) return committed;
    const failure =
      error instanceof ZodError
        ? AppError.badRequest(
            error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
          )
        : error;
    if (failure instanceof AppError && [400, 404, 409, 422].includes(failure.status)) {
      try {
        await OrderRequestModel.create({
          ...attempt,
          state: 'rejected',
          errorCode: failure.code,
          errorMessage: failure.message,
        });
      } catch (writeError) {
        const winner = await replay(attempt);
        if (winner) return winner;
        throw writeError;
      }
      throw new AppError(failure.code, failure.message, { orderRequestRejected: true });
    }
    throw error;
  }
}
