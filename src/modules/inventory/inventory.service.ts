import mongoose, { Types, FilterQuery } from 'mongoose';
import { createHash } from 'crypto';
import { AuditLogModel } from '@modules/audit/auditLog.model';
import { InventoryItemModel, InventoryItemDocument, InventoryUnit } from './inventoryItem.model';
import { StockMovementModel, StockMovementType } from './stockMovement.model';
import { RecipeModel } from './recipe.model';
import { AppError } from '@utils/AppError';
import { writeAuditLog } from '@modules/audit/audit.service';
import { getIo } from '@sockets/index';
import { logger } from '@utils/logger';
import { convert } from './units';

interface ActorCtx {
  idempotencyKey?: string;
  actorId?: string;
  actorEmail?: string;
  actorRole?: string;
  actorName?: string;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function emitLowStock(payload: unknown) {
  try {
    getIo().of('/staff').emit('inventory:low_stock', payload);
  } catch (err) {
    logger.debug({ err }, 'Skip low-stock broadcast');
  }
}

export interface CreateInventoryInput {
  name: string;
  sku?: string;
  unit: InventoryUnit;
  currentStock?: number;
  lowStockThreshold?: number;
  costPerUnit?: number;
  supplierName?: string;
  notes?: string;
}

export async function listInventory(opts: {
  q?: string;
  lowStock?: boolean;
  isActive?: boolean;
  page?: number;
  limit?: number;
}) {
  const page = Math.max(1, opts.page ?? 1);
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  const filter: FilterQuery<InventoryItemDocument> = {};
  if (typeof opts.isActive === 'boolean') filter.isActive = opts.isActive;
  if (opts.q) {
    const rx = new RegExp(opts.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ name: rx }, { sku: rx }, { supplierName: rx }];
  }
  if (opts.lowStock) filter.$expr = { $lte: ['$currentStock', '$lowStockThreshold'] };
  const [items, total] = await Promise.all([
    InventoryItemModel.find(filter)
      .sort({ name: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    InventoryItemModel.countDocuments(filter),
  ]);
  return { items, meta: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 } };
}

export async function getInventoryItem(id: string) {
  const it = await InventoryItemModel.findById(id).lean();
  if (!it) throw AppError.notFound('Inventory item not found');
  return it;
}

export async function listLowStock() {
  return InventoryItemModel.find({
    isActive: true,
    $expr: { $lte: ['$currentStock', '$lowStockThreshold'] },
  })
    .sort({ name: 1 })
    .lean();
}

export async function createInventoryItem(input: CreateInventoryInput, ctx: ActorCtx) {
  const existing = await InventoryItemModel.findOne({ name: input.name });
  if (existing) throw AppError.conflict(`Inventory item "${input.name}" exists`);
  const it = await InventoryItemModel.create({
    name: input.name,
    sku: input.sku,
    unit: input.unit,
    currentStock: input.currentStock ?? 0,
    lowStockThreshold: input.lowStockThreshold ?? 0,
    costPerUnit: input.costPerUnit,
    supplierName: input.supplierName,
    notes: input.notes,
  });
  await writeAuditLog({
    ...ctx,
    action: 'inventory.create',
    entity: 'InventoryItem',
    entityId: String(it._id),
    after: it.toObject(),
  });
  return it.toObject();
}

export interface UpdateInventoryInput {
  name?: string;
  sku?: string;
  unit?: InventoryUnit;
  lowStockThreshold?: number;
  costPerUnit?: number;
  supplierName?: string;
  notes?: string;
  isActive?: boolean;
}

export async function updateInventoryItem(id: string, input: UpdateInventoryInput, ctx: ActorCtx) {
  const it = await InventoryItemModel.findById(id);
  if (!it) throw AppError.notFound('Inventory item not found');
  const before = it.toObject();
  if (input.name !== undefined) it.name = input.name;
  if (input.sku !== undefined) it.sku = input.sku;
  if (input.unit !== undefined && input.unit !== it.unit)
    throw AppError.conflict(
      'Stock units are immutable. Create a new ingredient and migrate its recipes and stock with audited adjustments.',
    );
  if (input.lowStockThreshold !== undefined) it.lowStockThreshold = input.lowStockThreshold;
  if (input.costPerUnit !== undefined) it.costPerUnit = input.costPerUnit;
  if (input.supplierName !== undefined) it.supplierName = input.supplierName;
  if (input.notes !== undefined) it.notes = input.notes;
  if (typeof input.isActive === 'boolean') it.isActive = input.isActive;
  await it.save();
  await writeAuditLog({
    ...ctx,
    action: 'inventory.update',
    entity: 'InventoryItem',
    entityId: String(it._id),
    before,
    after: it.toObject(),
  });
  return it.toObject();
}

export async function deleteInventoryItem(id: string, ctx: ActorCtx) {
  const it = await InventoryItemModel.findById(id);
  if (!it) throw AppError.notFound('Inventory item not found');
  const usage = await RecipeModel.countDocuments({ 'ingredients.inventoryItemId': it._id });
  if (usage > 0) throw AppError.conflict(`Inventory item is used by ${usage} recipe(s)`);
  if (it.currentStock !== 0 || (await StockMovementModel.exists({ inventoryItemId: it._id })))
    throw AppError.conflict('Items with stock or movement history must be archived, not deleted');
  await InventoryItemModel.deleteOne({ _id: it._id });
  await writeAuditLog({
    ...ctx,
    action: 'inventory.delete',
    entity: 'InventoryItem',
    entityId: String(it._id),
    before: it.toObject(),
  });
}

export interface MovementInput {
  qty: number;
  unit?: InventoryUnit;
  reason?: string;
  costPerUnit?: number;
  supplierName?: string;
}

export async function stockIn(id: string, input: MovementInput, ctx: ActorCtx) {
  return applyMovement(id, 'in', Math.abs(input.qty), input, ctx);
}

export async function stockOut(id: string, input: MovementInput, ctx: ActorCtx) {
  return applyMovement(id, 'out', -Math.abs(input.qty), input, ctx);
}

export async function recordWaste(id: string, input: MovementInput, ctx: ActorCtx) {
  return applyMovement(id, 'waste', -Math.abs(input.qty), input, ctx);
}

export async function adjustStock(id: string, delta: number, reason: string, ctx: ActorCtx) {
  return applyMovement(id, 'adjustment', delta, { qty: Math.abs(delta), reason }, ctx);
}

async function applyMovement(
  id: string,
  type: StockMovementType,
  signedQty: number,
  input: MovementInput,
  ctx: ActorCtx,
) {
  if (!ctx.actorId) throw AppError.unauthorized();
  const operationKey = ctx.idempotencyKey;
  if (!operationKey || !/^[a-zA-Z0-9_-]{16,100}$/.test(operationKey))
    throw AppError.badRequest('A valid Idempotency-Key is required');
  if (!Number.isFinite(signedQty) || signedQty === 0)
    throw AppError.badRequest('Enter a nonzero stock quantity');
  const requestHash = createHash('sha256')
    .update(
      JSON.stringify({
        id,
        type,
        signedQty,
        unit: input.unit,
        reason: input.reason,
        costPerUnit: input.costPerUnit,
        supplierName: input.supplierName,
        actorId: ctx.actorId,
      }),
    )
    .digest('hex');
  async function replay(movement: import('./stockMovement.model').StockMovementDocument) {
    if (movement.requestHash !== requestHash)
      throw AppError.conflict('Idempotency key belongs to another stock operation');
    const item = await InventoryItemModel.findById(id);
    if (!item) throw AppError.notFound('Inventory item not found');
    return { item: item.toObject(), movement: movement.toObject() };
  }
  let result;
  try {
    result = await mongoose.connection.transaction(async (session) => {
      const prior = await StockMovementModel.findOne({ operationKey }).session(session);
      if (prior) return replay(prior);
      const it = await InventoryItemModel.findById(id).session(session);
      if (!it || !it.isActive) throw AppError.notFound('Active inventory item not found');
      const quantity =
        round3(
          input.unit ? convert(Math.abs(signedQty), input.unit, it.unit) : Math.abs(signedQty),
        ) * (signedQty < 0 ? -1 : 1);
      if (!quantity) throw AppError.badRequest('Quantity is below stock precision');
      const resulting = round3(it.currentStock + quantity);
      if (resulting < 0) throw AppError.conflict('This movement would make stock negative');
      const unitCost =
        input.costPerUnit === undefined
          ? undefined
          : input.costPerUnit * Math.abs(signedQty / quantity);
      if (type === 'in') {
        if (unitCost !== undefined)
          it.costPerUnit = round3(
            (Math.max(0, it.currentStock) * (it.costPerUnit ?? unitCost) + quantity * unitCost) /
              resulting,
          );
        it.lastStockInAt = new Date();
        if (input.supplierName) it.supplierName = input.supplierName;
      }
      it.currentStock = resulting;
      await it.save({ session });
      const [movement] = await StockMovementModel.create(
        [
          {
            inventoryItemId: it._id,
            type,
            qty: quantity,
            unit: it.unit,
            costPerUnit: unitCost,
            reason: input.reason,
            supplierName: input.supplierName,
            actorId: ctx.actorId,
            resultingStock: resulting,
            operationKey,
            requestHash,
          },
        ],
        { session },
      );
      await AuditLogModel.create(
        [
          {
            actorId: ctx.actorId,
            actorEmail: ctx.actorEmail,
            actorRole: ctx.actorRole,
            action: `inventory.${type}`,
            entity: 'InventoryItem',
            entityId: id,
            metadata: {
              qty: quantity,
              unit: it.unit,
              reason: input.reason,
              movementId: String(movement._id),
            },
            at: new Date(),
          },
        ],
        { session },
      );
      return { item: it.toObject(), movement: movement.toObject() };
    });
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    const prior = await StockMovementModel.findOne({ operationKey });
    if (!prior) throw error;
    result = await replay(prior);
  }
  if (result.item.currentStock <= result.item.lowStockThreshold)
    emitLowStock({
      id: String(result.item._id),
      name: result.item.name,
      currentStock: result.item.currentStock,
      threshold: result.item.lowStockThreshold,
      unit: result.item.unit,
    });
  return result;
}

export async function listMovements(opts: {
  inventoryItemId?: string;
  type?: StockMovementType;
  orderId?: string;
  from?: Date;
  to?: Date;
  page?: number;
  limit?: number;
}) {
  const page = Math.max(1, opts.page ?? 1);
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  const filter: Record<string, unknown> = {};
  if (opts.inventoryItemId) filter.inventoryItemId = new Types.ObjectId(opts.inventoryItemId);
  if (opts.type) filter.type = opts.type;
  if (opts.orderId) filter.orderId = new Types.ObjectId(opts.orderId);
  if (opts.from || opts.to) {
    filter.createdAt = {
      ...(opts.from ? { $gte: opts.from } : {}),
      ...(opts.to ? { $lte: opts.to } : {}),
    };
  }
  const [items, total] = await Promise.all([
    StockMovementModel.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    StockMovementModel.countDocuments(filter),
  ]);
  return { items, meta: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 } };
}

export async function buildSnapshot() {
  const items = await InventoryItemModel.find({ isActive: true }).sort({ name: 1 }).lean();
  const lowStock = items.filter((i) => i.currentStock <= i.lowStockThreshold);
  const totalValue = items.reduce(
    (s, i) => s + (i.costPerUnit ? i.currentStock * i.costPerUnit : 0),
    0,
  );
  return {
    at: new Date().toISOString(),
    itemCount: items.length,
    lowStockCount: lowStock.length,
    estimatedValue: Math.round(totalValue * 100) / 100,
    items: items.map((i) => ({
      id: String(i._id),
      name: i.name,
      unit: i.unit,
      currentStock: i.currentStock,
      lowStockThreshold: i.lowStockThreshold,
      isLow: i.currentStock <= i.lowStockThreshold,
      costPerUnit: i.costPerUnit,
      value: i.costPerUnit ? Math.round(i.currentStock * i.costPerUnit * 100) / 100 : undefined,
    })),
  };
}
