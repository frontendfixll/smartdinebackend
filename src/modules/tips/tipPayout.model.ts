import { Schema, model, Document, Types } from 'mongoose';

export type TipPoolMethod = 'hours' | 'equal';

export interface TipAllocation {
  userId: Types.ObjectId;
  name: string;
  workedMinutes: number;
  amount: number; // major units (dollars)
}

export interface TipPayoutDocument extends Document {
  _id: Types.ObjectId;
  businessDate: string; // YYYY-MM-DD Pacific
  method: TipPoolMethod;
  currency: string;
  totalTip: number; // major units
  allocations: TipAllocation[];
  generatedById?: Types.ObjectId;
  generatedByName?: string;
  createdAt: Date;
  updatedAt: Date;
}

const AllocationSchema = new Schema<TipAllocation>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true },
    workedMinutes: { type: Number, required: true, min: 0 },
    amount: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const TipPayoutSchema = new Schema<TipPayoutDocument>(
  {
    // One immutable payout snapshot per Pacific business day.
    businessDate: { type: String, required: true, unique: true, index: true },
    method: { type: String, enum: ['hours', 'equal'], required: true },
    currency: { type: String, required: true },
    totalTip: { type: Number, required: true, min: 0 },
    allocations: { type: [AllocationSchema], default: [] },
    generatedById: { type: Schema.Types.ObjectId, ref: 'User' },
    generatedByName: String,
  },
  { timestamps: true },
);

export const TipPayoutModel = model<TipPayoutDocument>('TipPayout', TipPayoutSchema);
