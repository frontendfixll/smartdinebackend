import { ServiceTask } from '@modules/tableService/task.model';
import { recordNotice } from '@modules/tableService/notices';
import { pilotZone, seatingOwner } from '@modules/tableService/assignment';
import { getOrCreateRestaurant } from '@modules/restaurant/restaurant.service';
import mongoose, { Types } from 'mongoose';
import { OrderModel } from '@modules/orders/order.model';
import { AuditLogModel } from '@modules/audit/auditLog.model';
import { ReservationModel } from '@modules/reservations/reservation.model';
import { overlapFilter } from '@modules/reservations/reservation.service';
import { TableSessionModel } from './tableSession.model';
import { TableModel } from './table.model';
import { AppError } from '@utils/AppError';
import { writeAuditLog } from '@modules/audit/audit.service';
import { getIo } from '@sockets/index';
import { logger } from '@utils/logger';

interface ActorCtx {
  actorId?: string;
  actorEmail?: string;
  actorRole?: string;
}

function emit(event: string, payload: unknown) {
  try {
    getIo().of('/staff').emit(event, payload);
  } catch (err) {
    logger.debug({ err }, 'Skip table-session event broadcast');
  }
}

export interface OpenSessionInput {
  tableId: string;
  guestCount?: number;
  waiterId?: string;
  customerId?: string;
}

export async function openSession(input: OpenSessionInput, ctx: ActorCtx) {
  const restaurant = await getOrCreateRestaurant();
  const result = await mongoose.connection.transaction(async (transaction) => {
    const table = await TableModel.findOneAndUpdate(
      {
        _id: input.tableId,
        isActive: true,
        status: 'vacant',
        currentSessionId: null,
        mergedIntoTableId: null,
      },
      { $inc: { scheduleVersion: 1 } },
      { new: true, session: transaction },
    );
    if (!table)
      throw AppError.conflict('The table must be vacant and ready before opening a visit');
    if (pilotZone(table.zone) && process.env.QR_SERVICE_MODE === 'live' && !input.guestCount)
      throw AppError.badRequest('Enter the party size to seat an enrolled table');
    if ((input.guestCount ?? 1) > table.capacity)
      throw AppError.conflict('Party exceeds table capacity');
    if (
      await ReservationModel.exists(overlapFilter(table._id, new Date(), 90)).session(transaction)
    )
      throw AppError.conflict(
        'Table is reserved during the next 90 minutes. Seat the booking from Reservations or choose another table.',
      );
    const [visit] = await TableSessionModel.create(
      [
        {
          tableId: table._id,
          currency: restaurant.currency,
          guestCount: input.guestCount ?? 1,
          ...(await seatingOwner(table.zone, input.guestCount ?? 1, transaction, input.waiterId)),
          customerId: input.customerId,
        },
      ],
      { session: transaction },
    );
    if (visit.qrService) await recordNotice(transaction,visit._id,'seated',visit.waiterId,ctx?.actorId);
    table.arrival = undefined;
    table.currentSessionId = visit._id;
    table.status = 'seated';
    await table.save({ session: transaction });
    await AuditLogModel.create(
      [
        {
          ...ctx,
          action: 'table_session.open',
          entity: 'TableSession',
          entityId: String(visit._id),
          metadata: { tableId: String(table._id), guestCount: visit.guestCount },
          at: new Date(),
        },
      ],
      { session: transaction },
    );
    return visit.toObject();
  });
  emit('table:status_changed', { id: String(result.tableId), to: 'seated' });
  return result;
}

export async function getSession(id: string) {
  const s = await TableSessionModel.findById(id).lean();
  if (!s) throw AppError.notFound('Session not found');
  return s;
}

export async function closeSession(id: string, ctx: ActorCtx) {
  const result = await mongoose.connection.transaction(async (transaction) => {
    const visit = await TableSessionModel.findById(id).session(transaction);
    if (!visit) throw AppError.notFound('Session not found');
    if (visit.status === 'closed') return visit.toObject();
    const active = await OrderModel.exists({
      tableSessionId: visit._id,
      status: { $nin: ['settled', 'cancelled'] },
    }).session(transaction);
    if (active)
      throw AppError.conflict('Settle or cancel all orders before closing this table visit');
    const table = await TableModel.findOneAndUpdate(
      { _id: visit.tableId, currentSessionId: visit._id },
      {
        $unset: { currentSessionId: 1 },
        $set: { status: 'cleaning' },
        $inc: { scheduleVersion: 1 },
      },
      { new: true, session: transaction },
    );
    if (!table) throw AppError.conflict('Table visit changed; refresh before closing');
    visit.status = 'closed';
    visit.closedAt = new Date();
    if (visit.qrService) {
      await ServiceTask.updateMany({visit:visit._id,state:{$in:['requested','acknowledged']}},
        {$set:{state:'cancelled',cancelledAt:visit.closedAt,cancelledBy:ctx.actorId}}, {session:transaction});
    }
    await visit.save({ session: transaction });
    await ReservationModel.updateOne(
      { tableSessionId: visit._id, status: 'checked_in' },
      { $set: { status: 'completed', completedAt: new Date() } },
      { session: transaction },
    );
    await AuditLogModel.create(
      [
        {
          ...ctx,
          action: 'table_session.close',
          entity: 'TableSession',
          entityId: id,
          metadata: { tableId: String(visit.tableId), runningTotal: visit.runningTotal },
          at: new Date(),
        },
      ],
      { session: transaction },
    );
    return visit.toObject();
  });
  emit('table:status_changed', { id: String(result.tableId), to: 'cleaning' });
  return result;
}

export async function listOpenSessions() {
  return TableSessionModel.find({ status: 'open' }).sort({ openedAt: -1 }).lean();
}

