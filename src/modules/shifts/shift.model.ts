import { Schema, model, Types } from 'mongoose';
export interface ShiftRecord {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  startedAt: Date;
  endedAt?: Date;
  status: 'open' | 'closed';
  breaks: { startedAt: Date; endedAt?: Date }[];
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}
const schema = new Schema<ShiftRecord>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    startedAt: { type: Date, required: true },
    endedAt: Date,
    status: { type: String, enum: ['open', 'closed'], default: 'open' },
    breaks: [{ startedAt: { type: Date, required: true }, endedAt: Date }],
    notes: String,
  },
  { timestamps: true },
);
schema.index({ userId: 1 }, { unique: true, partialFilterExpression: { status: 'open' } });
export const ShiftModel = model<ShiftRecord>('Shift', schema);
export function shiftSummary(shift: ShiftRecord) {
  const end = shift.endedAt?.getTime() ?? Date.now();
  const breakMs = shift.breaks.reduce(
    (total, b) => total + (b.endedAt?.getTime() ?? end) - b.startedAt.getTime(),
    0,
  );
  return {
    ...shift,
    workedMinutes: Math.max(0, Math.floor((end - shift.startedAt.getTime() - breakMs) / 60000)),
    breakMinutes: Math.floor(breakMs / 60000),
  };
}
