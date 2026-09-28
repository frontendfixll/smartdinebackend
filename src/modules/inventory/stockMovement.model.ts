import { Schema, model, Document, Types } from 'mongoose';
import { InventoryUnit } from './inventoryItem.model';

export type StockMovementType = 'in' | 'out' | 'waste' | 'adjustment' | 'recipe_deduction';

export interface StockMovementDocument extends Document {
  _id: Types.ObjectId;
  inventoryItemId: Types.ObjectId;
  operationKey?: string;
  requestHash?: string;
  type: StockMovementType;
  qty: number; // signed: +in, -out/waste/recipe_deduction; ± for adjustment
  unit: InventoryUnit;
  costPerUnit?: number;
  reason?: string;
  orderId?: Types.ObjectId;
  supplierName?: string;
  actorId?: Types.ObjectId;
  resultingStock: number;
  createdAt: Date;
}

const StockMovementSchema = new Schema<StockMovementDocument>(
  {
    operationKey: { type: String },
    requestHash: String,
    inventoryItemId: {
      type: Schema.Types.ObjectId,
      ref: 'InventoryItem',
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ['in', 'out', 'waste', 'adjustment', 'recipe_deduction'],
      required: true,
      index: true,
    },
    qty: { type: Number, required: true },
    unit: { type: String, enum: ['kg', 'g', 'L', 'ml', 'pcs'], required: true },
    costPerUnit: Number,
    reason: String,
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', index: true },
    supplierName: String,
    actorId: { type: Schema.Types.ObjectId, ref: 'User' },
    resultingStock: { type: Number, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

StockMovementSchema.index({ inventoryItemId: 1, createdAt: -1 });
StockMovementSchema.index(
  { operationKey: 1 },
  { unique: true, partialFilterExpression: { operationKey: { $type: 'string' } } },
);
StockMovementSchema.index({ orderId: 1, type: 1 });

export const StockMovementModel = model<StockMovementDocument>(
  'StockMovement',
  StockMovementSchema,
);
