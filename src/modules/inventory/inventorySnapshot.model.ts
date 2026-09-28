import { Schema, model, Document, Types } from 'mongoose';

export interface InventorySnapshotDocument extends Document {
  _id: Types.ObjectId;
  date: Date;
  items: Array<{
    itemId: Types.ObjectId;
    itemName: string;
    quantity: number;
    unit: string;
  }>;
  createdAt: Date;
}

const SnapshotSchema = new Schema<InventorySnapshotDocument>(
  {
    date: { type: Date, required: true, index: true },
    items: [
      {
        itemId: { type: Schema.Types.ObjectId, ref: 'Item', required: true },
        itemName: String,
        quantity: { type: Number, required: true },
        unit: { type: String, default: 'units' },
        _id: false,
      },
    ],
  },
  { timestamps: true },
);

SnapshotSchema.index({ date: -1 });

export const InventorySnapshotModel = model<InventorySnapshotDocument>(
  'InventorySnapshot',
  SnapshotSchema,
);
