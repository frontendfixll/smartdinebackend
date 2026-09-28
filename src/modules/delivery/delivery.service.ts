import mongoose from 'mongoose';
import { InvoiceModel } from '@modules/invoices/invoice.model';
import { OrderModel } from '@modules/orders/order.model';
import { UserModel } from '@modules/users/user.model';
import { RoleModel } from '@modules/roles/role.model';
import { AuditLogModel } from '@modules/audit/auditLog.model';
import { AppError } from '@utils/AppError';
import { emitToStaff, emitToGuestOrder } from '@modules/orders/orderEvents';
import {
  DeliveryActor,
  DeliveryChange,
  DeliveryConfigModel,
  DeliveryCreate,
  DeliveryModel,
  DeliveryState,
} from './delivery.model';

export async function deliveryConfig() {
  return (
    (await DeliveryConfigModel.findOne({ singleton: 'main' }).lean()) ?? {
      enabled: false,
      postalCodes: [],
      minimumOrder: 0,
      noAdditionalFee: false,
      instructions: '',
    }
  );
}
export async function saveDeliveryConfig(
  input: {
    enabled: boolean;
    postalCodes: string[];
    minimumOrder: number;
    noAdditionalFee: boolean;
    instructions: string;
  },
  actorId: string,
) {
  if (input.enabled && (!input.postalCodes.length || !input.noAdditionalFee))
    throw AppError.badRequest(
      'Confirm the service ZIP codes and no-additional-fee policy before enabling staff delivery',
    );
  return mongoose.connection.transaction(async (session) => {
    const config = await DeliveryConfigModel.findOneAndUpdate(
      { singleton: 'main' },
      { $set: input },
      { new: true, upsert: true, runValidators: true, session },
    );
    await AuditLogModel.create(
      [
        {
          actorId,
          action: 'delivery.config',
          entity: 'DeliveryConfig',
          entityId: String(config._id),
          after: input,
          at: new Date(),
        },
      ],
      { session },
    );
    return config;
  });
}
export async function listDrivers() {
  const roles = await RoleModel.find({ permissions: { $in: ['*', 'delivery:fulfill'] } }).select(
    '_id',
  );
  return UserModel.find({ isActive: true, roleId: { $in: roles.map((r) => r._id) } })
    .select('_id name')
    .sort({ name: 1 })
    .lean();
}
export async function createDelivery(input: DeliveryCreate, actor: DeliveryActor) {
  if (!actor.canManage) throw AppError.forbidden();
  const result = await mongoose.connection.transaction(async (session) => {
    const config = await DeliveryConfigModel.findOne({ singleton: 'main', enabled: true }).session(
      session,
    );
    if (!config?.noAdditionalFee) throw AppError.conflict('Staff delivery is not enabled');
    if (!config.postalCodes.includes(input.address.postalCode) || input.address.state !== 'CA')
      throw AppError.badRequest('The address is outside the configured California ZIP codes');
    if (!input.addressConfirmed) throw AppError.badRequest('Confirm the address with the guest');
    const existing = await DeliveryModel.findOne({ orderId: input.orderId }).session(session);
    if (existing) throw AppError.conflict('This order already has a delivery record');
    const order = await OrderModel.findById(input.orderId).session(session);
    if (!order) throw AppError.notFound('Order not found');
    if (
      order.tableId ||
      !['window', 'assisted'].includes(order.channel) ||
      ['served', 'settled', 'cancelled'].includes(order.status)
    )
      throw AppError.conflict('Choose an unfulfilled takeaway or counter order');
    await lockPaidInvoice(String(order._id), session);
    if (Math.round(order.totals.grand * 100) < Math.round(config.minimumOrder * 100))
      throw AppError.conflict('This order is below the configured delivery minimum');
    const [delivery] = await DeliveryModel.create(
      [
        {
          orderId: order._id,
          orderNumber: order.orderNumber,
          guestName: input.guestName,
          guestPhone: input.guestPhone,
          address: input.address,
          instructions: input.instructions,
          currency: order.currency ?? 'INR',
          total: order.totals.grand,
          events: [
            {
              status: 'pending',
              actorId: actor.actorId,
              note: 'Address confirmed with guest; no additional delivery fee',
            },
          ],
        },
      ],
      { session },
    );
    order.deliveryId = delivery._id;
    await order.save({ session });
    await AuditLogModel.create(
      [
        {
          actorId: actor.actorId,
          action: 'delivery.create',
          entity: 'Delivery',
          entityId: String(delivery._id),
          metadata: { orderId: String(order._id) },
          at: new Date(),
        },
      ],
      { session },
    );
    return delivery;
  });
  emitToStaff('order:updated', { id: input.orderId });
  return result;
}
const transitions: Record<DeliveryState, DeliveryState[]> = {
  pending: ['assigned', 'cancelled'],
  assigned: ['assigned', 'dispatched', 'cancelled'],
  dispatched: ['delivered', 'failed'],
  failed: ['assigned', 'cancelled'],
  delivered: [],
  cancelled: [],
};
export async function changeDelivery(id: string, input: DeliveryChange, actor: DeliveryActor) {
  const result = await mongoose.connection.transaction(async (session) => {
    const delivery = await DeliveryModel.findById(id).session(session);
    if (!delivery) throw AppError.notFound('Delivery not found');
    if (!actor.canManage && String(delivery.driverId) !== actor.actorId) throw AppError.forbidden();
    if (!actor.canManage && !['dispatched', 'delivered', 'failed'].includes(input.status))
      throw AppError.forbidden();
    if (delivery.status === input.status && input.status !== 'assigned') return delivery;
    if (delivery.status !== input.expectedStatus)
      throw AppError.conflict('Delivery changed. Refresh before updating it');
    if (!transitions[delivery.status].includes(input.status))
      throw AppError.conflict('This delivery transition is not allowed');
    if (['failed', 'cancelled'].includes(input.status) && !input.note?.trim())
      throw AppError.badRequest('A reason is required');
    if (delivery.status === 'failed' && !input.returnedToRestaurant)
      throw AppError.conflict(
        'Confirm the order was returned before retrying or switching to pickup',
      );
    const order = await OrderModel.findById(delivery.orderId).session(session);
    if (!order || String(order.deliveryId) !== id)
      throw AppError.conflict('The delivery is no longer attached to this order');
    if (input.status === 'assigned') {
      const driver = input.driverId
        ? await UserModel.findOne({ _id: input.driverId, isActive: true }).session(session)
        : null;
      const role = driver ? await RoleModel.findById(driver.roleId).session(session) : null;
      if (!driver || !role?.permissions.some((p) => p === '*' || p === 'delivery:fulfill'))
        throw AppError.badRequest('Choose an active staff member with delivery permission');
      delivery.driverId = driver._id;
      delivery.driverName = driver.name;
    }
    if (input.status === 'dispatched') await lockPaidInvoice(String(order._id), session);
    if (
      input.status === 'dispatched' &&
      (order.status !== 'ready' || order.paymentStatus !== 'paid')
    )
      throw AppError.conflict('Food must be ready and fully paid before dispatch');
    if (input.status === 'delivered') {
      if (order.status !== 'ready')
        throw AppError.conflict('Order status changed; manager review is required');
      delivery.deliveredAt = new Date();
      order.status = 'served';
      for (const item of order.items)
        if (item.status !== 'cancelled') {
          item.status = 'served';
          item.servedAt = delivery.deliveredAt;
        }
      order.timeline.push({
        _id: new mongoose.Types.ObjectId(),
        status: 'served',
        at: delivery.deliveredAt,
        byUserId: new mongoose.Types.ObjectId(actor.actorId),
        note: 'Delivery confirmed by staff',
      });
    }
    if (input.status === 'cancelled') order.deliveryId = undefined;
    // Write both documents to serialize dispatch against payment/refund and order changes.
    order.financialVersion += 1;
    await order.save({ session });
    delivery.status = input.status;
    delivery.events.push({
      status: input.status,
      actorId: new mongoose.Types.ObjectId(actor.actorId),
      note: input.note,
      at: new Date(),
    });
    await delivery.save({ session });
    await AuditLogModel.create(
      [
        {
          actorId: actor.actorId,
          action: `delivery.${input.status}`,
          entity: 'Delivery',
          entityId: id,
          metadata: { driverId: delivery.driverId, note: input.note },
          at: new Date(),
        },
      ],
      { session },
    );
    return delivery;
  });
  if (result.status === 'delivered') {
    const { maybeSettleOrder } = await import('@modules/payments/payment.service');
    await maybeSettleOrder(result.orderId, { actorId: actor.actorId });
  }
  emitToStaff('order:updated', { id: String(result.orderId) });
  emitToGuestOrder(String(result.orderId), 'delivery:updated', { status: result.status });
  return result;
}

async function lockPaidInvoice(orderId: string, session: mongoose.ClientSession) {
  const invoice = await InvoiceModel.findOneAndUpdate(
    { orderId, status: 'final', paymentStatus: 'paid', amountRefunded: { $in: [null, 0] } },
    { $inc: { __v: 1 } },
    { session, new: true },
  );
  if (!invoice)
    throw AppError.conflict(
      'A fully paid invoice without refunds is required before arranging or dispatching delivery',
    );
}
