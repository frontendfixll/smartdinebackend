import { Schema, model, Types } from 'mongoose';
const supplierSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: String,
    phone: String,
    address: String,
    notes: String,
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);
export const SupplierModel = model('Supplier', supplierSchema);
export interface PurchaseOrderRecord {
  _id: Types.ObjectId;
  number: string;
  supplierId: Types.ObjectId;
  supplierName: string;
  currency: string;
  status: 'draft' | 'ordered' | 'partial' | 'received' | 'cancelled';
  expectedAt?: Date;
  notes?: string;
  cancellationReason?: string;
  items: {
    _id: Types.ObjectId;
    inventoryItemId: Types.ObjectId;
    name: string;
    unit: string;
    quantity: number;
    received: number;
    unitCost: number;
  }[];
  createdBy: Types.ObjectId;
  orderedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}
const purchaseSchema = new Schema<PurchaseOrderRecord>(
  {
    number: { type: String, required: true, unique: true },
    supplierId: { type: Schema.Types.ObjectId, ref: 'Supplier', required: true },
    supplierName: { type: String, required: true },
    currency: { type: String, required: true },
    status: {
      type: String,
      enum: ['draft', 'ordered', 'partial', 'received', 'cancelled'],
      default: 'draft',
      index: true,
    },
    expectedAt: Date,
    notes: String,
    cancellationReason: String,
    items: [
      {
        inventoryItemId: { type: Schema.Types.ObjectId, ref: 'InventoryItem', required: true },
        name: { type: String, required: true },
        unit: { type: String, required: true },
        quantity: { type: Number, required: true, min: 0.001 },
        received: { type: Number, default: 0, min: 0 },
        unitCost: { type: Number, required: true, min: 0 },
      },
    ],
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    orderedAt: Date,
  },
  { timestamps: true },
);
export const PurchaseOrderModel = model<PurchaseOrderRecord>('PurchaseOrder', purchaseSchema);
const receiptSchema = new Schema(
  {
    purchaseOrderId: {
      type: Schema.Types.ObjectId,
      ref: 'PurchaseOrder',
      required: true,
      index: true,
    },
    operationKey: { type: String, required: true, unique: true },
    requestHash: { type: String, required: true },
    supplierInvoice: String,
    notes: String,
    actorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    items: [{ lineId: Schema.Types.ObjectId, quantity: Number }],
  },
  { timestamps: true },
);
export const GoodsReceiptModel = model('GoodsReceipt', receiptSchema);
