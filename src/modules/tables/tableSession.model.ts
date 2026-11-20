import { Schema, model, Document, Types } from 'mongoose';

export type TableSessionStatus = 'open' | 'closed';

export interface TableSessionDocument extends Document {
  _id: Types.ObjectId;
  tableId: Types.ObjectId;
  currency?: string;
  status: TableSessionStatus;
  openedAt: Date;
  closedAt?: Date;
  guestCount: number;
  suggestedWaiterId?: Types.ObjectId;
  offerTo?: Types.ObjectId;
  offerName?: string;
  offerExpiresAt?: Date;
  assignmentVersion?: number;
  assignedAt?: Date;
  qrService?: boolean;
  serviceVersion?: number;
  waiterName?: string;
  greetedAt?: Date;
  waiterId?: Types.ObjectId;
  customerId?: Types.ObjectId;
  orderIds: Types.ObjectId[];
  runningTotal: number;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const TableSessionSchema = new Schema<TableSessionDocument>(
  {
    currency: String,
    tableId: { type: Schema.Types.ObjectId, ref: 'Table', required: true, index: true },
    status: { type: String, enum: ['open', 'closed'], default: 'open', index: true },
    openedAt: { type: Date, default: () => new Date() },
    closedAt: { type: Date },
    guestCount: { type: Number, min: 1, default: 1 },
    suggestedWaiterId: Schema.Types.ObjectId,
    offerTo: Schema.Types.ObjectId, offerName: String, offerExpiresAt:Date,
    assignmentVersion: Number, assignedAt: Date, qrService: Boolean, serviceVersion: Number, waiterName: String, greetedAt: Date,
    waiterId: { type: Schema.Types.ObjectId, ref: 'User' },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer' },
    orderIds: [{ type: Schema.Types.ObjectId, ref: 'Order' }],
    runningTotal: { type: Number, default: 0, min: 0 },
    notes: { type: String, trim: true },
  },
  { timestamps: true },
);

TableSessionSchema.index({ tableId: 1, status: 1 });
TableSessionSchema.index({ tableId: 1 }, { name:'one_open_qr_visit', unique:true,
  partialFilterExpression:{qrService:true,status:'open'} });

export const TableSessionModel = model<TableSessionDocument>('TableSession', TableSessionSchema);

