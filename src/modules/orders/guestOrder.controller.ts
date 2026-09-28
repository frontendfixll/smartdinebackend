import { DeliveryModel } from '@modules/delivery/delivery.model';
import { FeedbackModel } from '@modules/feedback/feedback.model';
import { OrderModel } from './order.model';
import { signOrderAccess, verifyOrderAccess } from '@modules/auth/orderAccess.service';
import { pacificDateTime } from '@utils/pacificDateTime';
import { Request, Response } from 'express';
import { asyncHandler } from '@utils/asyncHandler';
import { ok, created } from '@utils/apiResponse';
import { AppError } from '@utils/AppError';
import * as svc from './order.service';
import { toGuestDTO } from './order.service';
import { orderRequest, runOrderRequest } from './orderRequest.service';
import * as v from './order.validators';

// The public display receives queue tokens only, never guest/order details.
export const nowServing = asyncHandler(async (_req: Request, res: Response) => {
  const orders = await OrderModel.find({
    channel: 'window',
    status: { $in: ['placed', 'accepted', 'preparing', 'ready'] },
    windowToken: { $exists: true, $ne: null },
    deliveryId: { $exists: false },
  })
    .select('windowToken status updatedAt -_id')
    .sort({ createdAt: -1 })
    .limit(200)
    .lean();
  res.setHeader('Cache-Control', 'no-store');
  return ok(
    res,
    orders.map((o) => ({
      token: o.windowToken,
      status: o.status === 'accepted' ? 'preparing' : o.status,
      at: new Date(o.updatedAt).getTime(),
    })),
  );
});

export const quote = asyncHandler(async (req: Request, res: Response) =>
  ok(res, await svc.quoteGuestItems(req.body.items)),
);

export const placeDineIn = asyncHandler(async (req: Request, res: Response) => {
  const order = await runOrderRequest(
    orderRequest(req.headers['idempotency-key'], 'guest:dine-in', 'place:dine-in', req.body),
    (attempt) => svc.placeDineInOrder(v.placeDineInGuestSchema.parse(req.body), {}, attempt),
  );
  return created(res, {
    ...toGuestDTO(order),
    orderAccessToken: signOrderAccess(String(order._id), order.orderNumber),
  });
});

export const placeWindow = asyncHandler(async (req: Request, res: Response) => {
  if (!req.guest?.phone) throw AppError.unauthorized('Guest token required');
  const phone = req.guest.phone;
  const order = await runOrderRequest(
    orderRequest(req.headers['idempotency-key'], `guest:window:${phone}`, 'place:window', req.body),
    (attempt) => {
      const { pickupLocal, ...input } = v.placeWindowGuestSchema.parse(req.body);
      if (pickupLocal) {
        const [date, time] = pickupLocal.split('T');
        input.pickupAt = pacificDateTime(date, time);
      }
      if (input.pickupAt && input.pickupAt.getTime() <= Date.now())
        throw AppError.badRequest('Choose a future pickup time in Pacific time');
      return svc.placeWindowOrder(input, phone, { actorName: `Guest:${phone}` }, attempt);
    },
  );
  return created(res, {
    ...toGuestDTO(order),
    orderAccessToken: signOrderAccess(String(order._id), order.orderNumber),
  });
});

export const getStatus = asyncHandler(async (req: Request, res: Response) => {
  const order = await svc.getOrder(req.params.id);
  const delivery = order.deliveryId
    ? await DeliveryModel.findById(order.deliveryId).select('status deliveredAt').lean()
    : undefined;
  return ok(res, {
    ...toGuestDTO(order),
    feedbackSubmitted: Boolean(await FeedbackModel.exists({ orderId: order._id })),
    delivery: delivery ? { status: delivery.status, deliveredAt: delivery.deliveredAt } : undefined,
  });
});

export const getByOrderNumber = asyncHandler(async (req: Request, res: Response) => {
  const access = verifyOrderAccess(req.headers['x-order-token']);
  if (access.orderNumber !== req.params.orderNumber)
    throw AppError.unauthorized('Order access does not match');
  const order = await svc.getOrder(access.sub);
  if (!order) throw AppError.notFound('Order not found');
  const delivery = order.deliveryId
    ? await DeliveryModel.findById(order.deliveryId).select('status deliveredAt').lean()
    : undefined;
  return ok(res, {
    ...toGuestDTO(order),
    delivery: delivery ? { status: delivery.status, deliveredAt: delivery.deliveredAt } : undefined,
  });
});

export const sendRequest = asyncHandler(async (req: Request, res: Response) => {
  const r = await svc.addGuestRequest(req.params.id, req.body.type, req.body.message);
  return created(res, r);
});

export const addItems = asyncHandler(async (req: Request, res: Response) => {
  const guestCtx = req.guest?.phone ? { actorName: `Guest:${req.guest.phone}` } : {};
  const order = await runOrderRequest(
    orderRequest(
      req.headers['idempotency-key'],
      `guest:order:${req.params.id}`,
      'add-items',
      req.body,
    ),
    (attempt) => {
      const input = v.addItemsSchema.parse(req.body);
      if (input.maxTotal === undefined)
        throw AppError.badRequest('Review the current total before adding items');
      return svc.addItemsToOrder(req.params.id, input.items, guestCtx, input.maxTotal, attempt);
    },
  );
  return ok(res, toGuestDTO(order));
});

export const initiatePayment = asyncHandler(async (req: Request, res: Response) => {
  const { initiateGuestPayment } = await import('@modules/invoices/invoice.service');
  const result = await initiateGuestPayment(req.params.id, req.body.tip);
  return created(res, result);
});
