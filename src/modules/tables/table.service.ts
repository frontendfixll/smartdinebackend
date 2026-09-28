import mongoose, { Types, ClientSession } from 'mongoose';
import { ReservationModel } from '@modules/reservations/reservation.model';
import { overlapFilter } from '@modules/reservations/reservation.service';
import { AuditLogModel } from '@modules/audit/auditLog.model';
import { OrderModel } from '@modules/orders/order.model';
import { TableModel, TableDocument, TableStatus } from './table.model';
import { TableSessionModel } from './tableSession.model';
import { QrCodeModel } from '@modules/qr/qrCode.model';
import { AppError } from '@utils/AppError';
import { writeAuditLog } from '@modules/audit/audit.service';
import { getIo } from '@sockets/index';
import { logger } from '@utils/logger';

interface ActorCtx {
  actorId?: string;
  actorEmail?: string;
  actorRole?: string;
}

const VALID_TRANSITIONS: Record<TableStatus, TableStatus[]> = {
  vacant: ['seated', 'cleaning'],
  seated: ['ordered', 'awaiting_bill', 'cleaning', 'vacant'],
  ordered: ['awaiting_bill', 'cleaning'],
  awaiting_bill: ['cleaning', 'vacant'],
  cleaning: ['vacant'],
};

function emitTableEvent(event: string, payload: unknown) {
  try {
    getIo().of('/staff').emit(event, payload);
  } catch (err) {
    logger.debug({ err }, 'Skip table event broadcast');
  }
}

export async function listTables(
  opts: { status?: TableStatus; zone?: string; includeInactive?: boolean } = {},
) {
  const filter: Record<string, unknown> = { mergedIntoTableId: { $exists: false } };
  if (opts.status) filter.status = opts.status;
  if (opts.zone) filter.zone = opts.zone;
  if (!opts.includeInactive) filter.isActive = true;
  return TableModel.find(filter).sort({ sortOrder: 1, number: 1 }).lean();
}

export async function getTable(id: string) {
  const t = await TableModel.findById(id).lean();
  if (!t) throw AppError.notFound('Table not found');
  return t;
}

export interface CreateTableInput {
  number: string;
  zone?: string;
  capacity?: number;
  shape?: 'round' | 'square' | 'rect';
  position?: { x: number; y: number };
  sortOrder?: number;
}

export async function createTable(input: CreateTableInput, ctx: ActorCtx) {
  const existing = await TableModel.findOne({ number: input.number });
  if (existing) throw AppError.conflict(`Table "${input.number}" already exists`);
  const t = await TableModel.create({
    number: input.number,
    zone: input.zone,
    capacity: input.capacity ?? 4,
    shape: input.shape,
    position: input.position,
    sortOrder: input.sortOrder ?? 0,
  });
  await writeAuditLog({
    ...ctx,
    action: 'table.create',
    entity: 'Table',
    entityId: String(t._id),
    after: t.toObject(),
  });
  emitTableEvent('table:updated', { id: String(t._id), action: 'create' });
  return t.toObject();
}

export interface BulkCreateInput {
  tables: CreateTableInput[];
}

export async function bulkCreateTables(input: BulkCreateInput, ctx: ActorCtx) {
  const numbers = input.tables.map((t) => t.number);
  const existing = await TableModel.find({ number: { $in: numbers } })
    .select('number')
    .lean();
  if (existing.length) {
    throw AppError.conflict(`Tables already exist: ${existing.map((e) => e.number).join(', ')}`);
  }
  const docs = await TableModel.insertMany(
    input.tables.map((t, i) => ({
      number: t.number,
      zone: t.zone,
      capacity: t.capacity ?? 4,
      sortOrder: t.sortOrder ?? i,
    })),
  );
  await writeAuditLog({
    ...ctx,
    action: 'table.bulk_create',
    entity: 'Table',
    metadata: { count: docs.length, numbers },
  });
  emitTableEvent('table:updated', { action: 'bulk_create', count: docs.length });
  return docs.map((d) => d.toObject());
}

export interface UpdateTableInput {
  number?: string;
  zone?: string;
  capacity?: number;
  shape?: 'round' | 'square' | 'rect';
  position?: { x: number; y: number } | null;
  sortOrder?: number;
  isActive?: boolean;
}

export async function updateTable(id: string, input: UpdateTableInput, ctx: ActorCtx) {
  const result = await mongoose.connection.transaction(async (session) => {
    const t = await TableModel.findById(id).session(session);
    if (!t) throw AppError.notFound('Table not found');
    const before = t.toObject();
    if (
      (input.capacity !== undefined && input.capacity !== t.capacity) ||
      input.isActive === false
    ) {
      if (t.mergedIntoTableId || t.mergedWithTableIds.length)
        throw AppError.conflict('Split the table group before changing capacity or archiving');
      await assertReconfigurable([t], session);
    }
    if (input.number !== undefined && input.number !== t.number) {
      if (await TableModel.exists({ number: input.number, _id: { $ne: t._id } }).session(session))
        throw AppError.conflict(`Table "${input.number}" already exists`);
    }
    for (const [field, value] of Object.entries(input))
      if (value !== undefined)
        t.set(field, field === 'position' && value === null ? undefined : value);
    await t.save({ session });
    await AuditLogModel.create(
      [
        {
          ...ctx,
          action: 'table.update',
          entity: 'Table',
          entityId: id,
          before,
          after: t.toObject(),
          at: new Date(),
        },
      ],
      { session },
    );
    return t.toObject();
  });
  emitTableEvent('table:updated', { id, action: 'update' });
  return result;
}

export async function deleteTable(id: string, ctx: ActorCtx) {
  await mongoose.connection.transaction(async (session) => {
    const t = await TableModel.findById(id).session(session);
    if (!t) throw AppError.notFound('Table not found');
    if (t.mergedIntoTableId || t.mergedWithTableIds.length)
      throw AppError.conflict('Split the table group before deleting');
    await assertReconfigurable([t], session);
    if (await QrCodeModel.exists({ tableId: t._id }).session(session))
      throw AppError.conflict('Remove table QR codes before deleting');
    if (
      (await TableSessionModel.exists({ tableId: t._id }).session(session)) ||
      (await ReservationModel.exists({ tableId: t._id }).session(session)) ||
      (await OrderModel.exists({ tableId: t._id }).session(session))
    )
      throw AppError.conflict('This table has history; archive it instead');
    await TableModel.deleteOne({ _id: t._id }, { session });
    await AuditLogModel.create(
      [
        {
          ...ctx,
          action: 'table.delete',
          entity: 'Table',
          entityId: id,
          before: t.toObject(),
          at: new Date(),
        },
      ],
      { session },
    );
  });
  emitTableEvent('table:updated', { id, action: 'delete' });
}

export async function transitionStatus(id: string, next: TableStatus, ctx: ActorCtx) {
  const t = await TableModel.findById(id);
  if (!t) throw AppError.notFound('Table not found');
  if (t.status === next) return t.toObject();
  const allowed = VALID_TRANSITIONS[t.status];
  if (!allowed.includes(next)) {
    throw AppError.badRequest(`Cannot transition table from "${t.status}" to "${next}"`);
  }
  const before = t.status;
  if (next === 'seated' && !t.currentSessionId) {
    const { openSession } = await import('./tableSession.service');
    await openSession({ tableId: id }, ctx);
    return (await TableModel.findById(id))!.toObject();
  }
  if ((next === 'cleaning' || next === 'vacant') && t.currentSessionId) {
    const { closeSession } = await import('./tableSession.service');
    await closeSession(String(t.currentSessionId), ctx);
    return (await TableModel.findById(id))!.toObject();
  }
  const changed = await TableModel.findOneAndUpdate(
    { _id: t._id, status: before, currentSessionId: t.currentSessionId ?? null },
    { $set: { status: next }, $inc: { scheduleVersion: 1 } },
    { new: true },
  );
  if (!changed) throw AppError.conflict('Table changed; refresh and try again');
  t.status = changed.status;
  await writeAuditLog({
    ...ctx,
    action: 'table.status_change',
    entity: 'Table',
    entityId: String(t._id),
    metadata: { from: before, to: next },
  });
  emitTableEvent('table:status_changed', { id: String(t._id), from: before, to: next });
  return t.toObject();
}

async function assertReconfigurable(tables: TableDocument[], session: ClientSession) {
  for (const table of tables) {
    if (table.currentSessionId || table.status !== 'vacant')
      throw AppError.conflict('Tables must be vacant before changing their layout');
    await TableModel.updateOne({ _id: table._id }, { $inc: { scheduleVersion: 1 } }, { session });
  }
  if (
    await ReservationModel.exists({
      tableId: { $in: tables.map((t) => t._id) },
      status: { $in: ['confirmed', 'checked_in'] },
      $or: [{ endsAt: { $gte: new Date() } }, { endsAt: { $exists: false } }],
    }).session(session)
  )
    throw AppError.conflict('Resolve assigned bookings before changing table capacity or layout');
}
export async function mergeTables(primaryId: string, secondaryIds: string[], ctx: ActorCtx) {
  if (secondaryIds.includes(primaryId) || new Set(secondaryIds).size !== secondaryIds.length)
    throw AppError.badRequest('Choose distinct tables');
  const result = await mongoose.connection.transaction(async (session) => {
    const primary = await TableModel.findById(primaryId).session(session);
    const secondaries = await TableModel.find({ _id: { $in: secondaryIds } }).session(session);
    if (!primary || secondaries.length !== secondaryIds.length)
      throw AppError.notFound('Table not found');
    const all = [primary, ...secondaries];
    if (all.some((t) => !t.isActive || t.mergedIntoTableId || t.mergedWithTableIds.length))
      throw AppError.conflict('Split existing groups before merging tables');
    await assertReconfigurable(all, session);
    const total = all.reduce((sum, t) => sum + t.capacity, 0);
    if (total > 50) throw AppError.badRequest('Merged capacity must not exceed 50');
    for (const t of secondaries) {
      t.mergedIntoTableId = primary._id;
      await t.save({ session });
    }
    primary.mergedWithTableIds = secondaries.map((t) => t._id);
    primary.capacity = total;
    await primary.save({ session });
    await AuditLogModel.create(
      [
        {
          ...ctx,
          action: 'table.merge',
          entity: 'Table',
          entityId: primaryId,
          metadata: { secondaryIds },
          at: new Date(),
        },
      ],
      { session },
    );
    return primary.toObject();
  });
  emitTableEvent('table:merged', { primaryId, secondaryIds });
  return result;
}
export async function splitTables(primaryId: string, ctx: ActorCtx) {
  const result = await mongoose.connection.transaction(async (session) => {
    const primary = await TableModel.findById(primaryId).session(session);
    if (!primary) throw AppError.notFound('Table not found');
    if (!primary.mergedWithTableIds.length) throw AppError.conflict('Table is not merged');
    const secondaries = await TableModel.find({ _id: { $in: primary.mergedWithTableIds } }).session(
      session,
    );
    await assertReconfigurable([primary, ...secondaries], session);
    primary.capacity -= secondaries.reduce((sum, t) => sum + t.capacity, 0);
    if (primary.capacity < 1) throw AppError.conflict('Merged capacities need reconciliation');
    primary.mergedWithTableIds = [];
    for (const t of secondaries) {
      t.mergedIntoTableId = undefined;
      await t.save({ session });
    }
    await primary.save({ session });
    await AuditLogModel.create(
      [{ ...ctx, action: 'table.split', entity: 'Table', entityId: primaryId, at: new Date() }],
      { session },
    );
    return primary.toObject();
  });
  emitTableEvent('table:split', { primaryId });
  return result;
}
export async function moveSession(fromTableId: string, toTableId: string, ctx: ActorCtx) {
  if (fromTableId === toTableId) throw AppError.badRequest('Choose a different destination');
  const result = await mongoose.connection.transaction(async (session) => {
    const from = await TableModel.findById(fromTableId).session(session);
    const to = await TableModel.findById(toTableId).session(session);
    if (!from || !to) throw AppError.notFound('Table not found');
    if (!from.currentSessionId) throw AppError.conflict('Source has no active visit');
    if (!to.isActive || to.currentSessionId || to.status !== 'vacant' || to.mergedIntoTableId)
      throw AppError.conflict('Destination must be vacant and ready');
    const visit = await TableSessionModel.findOne({
      _id: from.currentSessionId,
      status: 'open',
    }).session(session);
    if (!visit) throw AppError.conflict('Visit is closed');
    if (visit.guestCount > to.capacity)
      throw AppError.conflict('Destination cannot seat this party');
    await TableModel.updateOne({ _id: to._id }, { $inc: { scheduleVersion: 1 } }, { session });
    if (await ReservationModel.exists(overlapFilter(to._id, new Date(), 90)).session(session))
      throw AppError.conflict('Destination has an overlapping reservation');
    to.currentSessionId = visit._id;
    to.status = from.status;
    from.currentSessionId = undefined;
    from.status = 'cleaning';
    await from.save({ session });
    await to.save({ session });
    visit.tableId = to._id;
    await visit.save({ session });
    await OrderModel.updateMany(
      { tableSessionId: visit._id, status: { $nin: ['settled', 'cancelled'] } },
      { $set: { tableId: to._id } },
      { session },
    );
    await ReservationModel.updateOne(
      { tableSessionId: visit._id, status: 'checked_in' },
      { $set: { tableId: to._id } },
      { session },
    );
    await AuditLogModel.create(
      [
        {
          ...ctx,
          action: 'table.move',
          entity: 'TableSession',
          entityId: String(visit._id),
          metadata: { fromTableId, toTableId },
          at: new Date(),
        },
      ],
      { session },
    );
    return { from: from.toObject(), to: to.toObject() };
  });
  emitTableEvent('table:moved', { fromTableId, toTableId });
  return result;
}
