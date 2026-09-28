import mongoose from 'mongoose';
import { ShiftModel, shiftSummary } from './shift.model';
import { AuditLogModel } from '@modules/audit/auditLog.model';
import { AppError } from '@utils/AppError';
export async function clockIn(userId: string) {
  try {
    return await mongoose.connection.transaction(async (session) => {
      const active = await ShiftModel.findOne({ userId, status: 'open' }).session(session);
      if (active) return shiftSummary(active.toObject());
      const [shift] = await ShiftModel.create([{ userId, startedAt: new Date(), status: 'open' }], {
        session,
      });
      await AuditLogModel.create(
        [
          {
            actorId: userId,
            action: 'shift.clock_in',
            entity: 'Shift',
            entityId: String(shift._id),
            at: new Date(),
          },
        ],
        { session },
      );
      return shiftSummary(shift.toObject());
    });
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    const active = await ShiftModel.findOne({ userId, status: 'open' });
    if (!active) throw error;
    return shiftSummary(active.toObject());
  }
}
export async function shiftAction(
  userId: string,
  id: string,
  action: 'break_start' | 'break_end' | 'clock_out',
  notes?: string,
) {
  return mongoose.connection.transaction(async (session) => {
    const shift = await ShiftModel.findOne({ _id: id, userId }).session(session);
    if (!shift) throw AppError.notFound('Shift not found');
    if (shift.status === 'closed') {
      if (action === 'clock_out') return shiftSummary(shift.toObject());
      throw AppError.conflict('Shift is already closed');
    }
    const active = shift.breaks.find((b) => !b.endedAt);
    const now = new Date();
    if (action === 'break_start') {
      if (!active) shift.breaks.push({ startedAt: now });
    }
    if (action === 'break_end') {
      if (!active) throw AppError.conflict('No break is in progress');
      active.endedAt = now;
    }
    if (action === 'clock_out') {
      if (active) active.endedAt = now;
      shift.endedAt = now;
      shift.status = 'closed';
      shift.notes = notes;
    }
    await shift.save({ session });
    await AuditLogModel.create(
      [{ actorId: userId, action: `shift.${action}`, entity: 'Shift', entityId: id, at: now }],
      { session },
    );
    return shiftSummary(shift.toObject());
  });
}
