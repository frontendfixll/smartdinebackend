import { Schema, model } from 'mongoose';
const schema = new Schema(
  {
    businessDate: { type: String, required: true },
    currency: { type: String, required: true },
    timeZone: { type: String, default: 'America/Los_Angeles' },
    closedById: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    summary: { type: Schema.Types.Mixed, required: true },
    // A reopened day is no longer locked; corrections are allowed until it is closed again.
    reopenedAt: { type: Date },
    reopenedById: { type: Schema.Types.ObjectId, ref: 'User' },
    reopenReason: { type: String },
  },
  { timestamps: true, minimize: false },
);
schema.index({ businessDate: 1, currency: 1 }, { unique: true });
export const DayCloseModel = model('DayClose', schema);
