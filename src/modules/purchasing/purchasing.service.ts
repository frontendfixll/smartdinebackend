import mongoose, { Types } from 'mongoose';
import { createHash, randomUUID } from 'crypto';
import { SupplierModel, PurchaseOrderModel, GoodsReceiptModel } from './purchasing.model';
import { InventoryItemModel } from '@modules/inventory/inventoryItem.model';
import { StockMovementModel } from '@modules/inventory/stockMovement.model';
import { AuditLogModel } from '@modules/audit/auditLog.model';
import { getOrCreateRestaurant } from '@modules/restaurant/restaurant.service';
import { AppError } from '@utils/AppError';
const round3 = (n: number) => Math.round(n * 1000) / 1000;
export async function createPurchase(
  input: {
    supplierId: string;
    expectedAt?: Date;
    notes?: string;
    items: { inventoryItemId: string; quantity: number; unitCost: number }[];
  },
  actorId: string,
) {
  const restaurant = await getOrCreateRestaurant();
  return mongoose.connection.transaction(async (session) => {
    const supplier = await SupplierModel.findOne({ _id: input.supplierId, isActive: true }).session(
      session,
    );
    if (!supplier) throw AppError.notFound('Active supplier not found');
    const lines = [];
    for (const line of input.items) {
      const item = await InventoryItemModel.findOne({
        _id: line.inventoryItemId,
        isActive: true,
      }).session(session);
      if (!item) throw AppError.notFound('Active ingredient not found');
      lines.push({ ...line, name: item.name, unit: item.unit, received: 0 });
    }
    const [order] = await PurchaseOrderModel.create(
      [
        {
          number: `PO-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${randomUUID().slice(0, 8).toUpperCase()}`,
          supplierId: supplier._id,
          supplierName: supplier.name,
          currency: restaurant.currency,
          items: lines,
          notes: input.notes,
          expectedAt: input.expectedAt,
          createdBy: actorId,
        },
      ],
      { session },
    );
    await AuditLogModel.create(
      [
        {
          actorId,
          action: 'purchase.create',
          entity: 'PurchaseOrder',
          entityId: String(order._id),
          at: new Date(),
        },
      ],
      { session },
    );
    return order;
  });
}
export async function changePurchase(
  id: string,
  status: 'ordered' | 'cancelled',
  reason: string | undefined,
  actorId: string,
) {
  return mongoose.connection.transaction(async (session) => {
    const order = await PurchaseOrderModel.findById(id).session(session);
    if (!order) throw AppError.notFound('Purchase order not found');
    if (order.status === status) return order;
    if (status === 'ordered' && order.status !== 'draft')
      throw AppError.conflict('Only a draft can be marked ordered');
    if (status === 'cancelled' && !['draft', 'ordered', 'partial'].includes(order.status))
      throw AppError.conflict('This purchase order cannot be cancelled');
    if (status === 'cancelled' && !reason?.trim())
      throw AppError.badRequest('Explain why the remaining quantities are cancelled');
    order.status = status;
    if (status === 'ordered') order.orderedAt = new Date();
    else order.cancellationReason = reason;
    await order.save({ session });
    await AuditLogModel.create(
      [
        {
          actorId,
          action: `purchase.${status}`,
          entity: 'PurchaseOrder',
          entityId: id,
          metadata: { reason },
          at: new Date(),
        },
      ],
      { session },
    );
    return order;
  });
}
export async function receivePurchase(
  id: string,
  input: {
    items: { lineId: string; quantity: number }[];
    supplierInvoice?: string;
    notes?: string;
  },
  actorId: string,
  operationKey: string | undefined,
) {
  if (!operationKey || !/^[a-zA-Z0-9_-]{16,100}$/.test(operationKey))
    throw AppError.badRequest('A valid Idempotency-Key is required');
  const requestHash = createHash('sha256')
    .update(
      JSON.stringify({
        id,
        actorId,
        items: [...input.items].sort((a, b) => a.lineId.localeCompare(b.lineId)),
        supplierInvoice: input.supplierInvoice,
        notes: input.notes,
      }),
    )
    .digest('hex');
  const replay = async (receipt: InstanceType<typeof GoodsReceiptModel>) => {
    if (receipt.requestHash !== requestHash)
      throw AppError.conflict('Receipt key belongs to a different delivery');
    return { receipt, order: await PurchaseOrderModel.findById(id) };
  };
  try {
    return await mongoose.connection.transaction(async (session) => {
      const prior = await GoodsReceiptModel.findOne({ operationKey }).session(session);
      if (prior) return replay(prior);
      const order = await PurchaseOrderModel.findById(id).session(session);
      if (!order) throw AppError.notFound('Purchase order not found');
      if (!['ordered', 'partial'].includes(order.status))
        throw AppError.conflict('This purchase order is not accepting deliveries');
      for (const received of input.items) {
        if (
          !Number.isFinite(received.quantity) ||
          received.quantity <= 0 ||
          round3(received.quantity) !== received.quantity
        )
          throw AppError.badRequest('Quantity must be positive with at most three decimals');
        const line = order.items.find((l) => String(l._id) === received.lineId);
        if (!line) throw AppError.badRequest('Unknown purchase line');
        if (round3(line.received + received.quantity) > line.quantity)
          throw AppError.conflict(`Delivery exceeds the remaining quantity for ${line.name}`);
        const item = await InventoryItemModel.findById(line.inventoryItemId).session(session);
        if (!item || item.unit !== line.unit)
          throw AppError.conflict(`Ingredient ${line.name} was removed or its unit changed`);
        const priorStock = Math.max(0, item.currentStock);
        const newStock = round3(item.currentStock + received.quantity);
        item.costPerUnit = round3(
          (priorStock * (item.costPerUnit ?? line.unitCost) + received.quantity * line.unitCost) /
            (priorStock + received.quantity),
        );
        item.currentStock = newStock;
        item.lastStockInAt = new Date();
        item.supplierName = order.supplierName;
        await item.save({ session });
        line.received = round3(line.received + received.quantity);
        await StockMovementModel.create(
          [
            {
              inventoryItemId: item._id,
              type: 'in',
              qty: received.quantity,
              unit: item.unit,
              costPerUnit: line.unitCost,
              supplierName: order.supplierName,
              actorId,
              resultingStock: newStock,
              reason: `Received ${order.number}${input.supplierInvoice ? ` / ${input.supplierInvoice}` : ''}`,
              operationKey: `${operationKey}_${line._id}`,
              requestHash,
            },
          ],
          { session },
        );
      }
      order.status = order.items.every((l) => l.received === l.quantity) ? 'received' : 'partial';
      await order.save({ session });
      const [receipt] = await GoodsReceiptModel.create(
        [{ purchaseOrderId: order._id, operationKey, requestHash, actorId, ...input }],
        { session },
      );
      await AuditLogModel.create(
        [
          {
            actorId,
            action: 'purchase.receive',
            entity: 'PurchaseOrder',
            entityId: id,
            metadata: { receiptId: String(receipt._id), status: order.status, items: input.items },
            at: new Date(),
          },
        ],
        { session },
      );
      return { order, receipt };
    });
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    const receipt = await GoodsReceiptModel.findOne({ operationKey });
    if (!receipt) throw error;
    return replay(receipt);
  }
}
