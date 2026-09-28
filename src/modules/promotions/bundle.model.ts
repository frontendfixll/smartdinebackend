import { Schema, model, Document, Types } from 'mongoose';

export type BundleType = 'bogo' | 'combo_discount' | 'volume_discount';
export type CustomerTag = 'first_time' | 'regular' | 'vip' | 'corporate' | 'seasonal';

export interface BundleDocument extends Document {
  _id: Types.ObjectId;
  name: string;
  description?: string;
  type: BundleType;
  isActive: boolean;
  
  // BOGO: Buy One Get One config
  triggerItemId?: Types.ObjectId;
  freeItemId?: Types.ObjectId;
  minQuantity: number;
  
  // Combo discount config
  itemIds?: Types.ObjectId[];
  discountPercent?: number;
  discountAmount?: number;
  
  // Applicability
  applicableToTags?: CustomerTag[];
  minOrderValue?: number;
  maxUsesPerCustomer?: number;
  validFrom: Date;
  validTill: Date;
  
  createdAt: Date;
  updatedAt: Date;
}

const BundleSchema = new Schema<BundleDocument>(
  {
    name: { type: String, required: true, unique: true, trim: true },
    description: String,
    type: { type: String, enum: ['bogo', 'combo_discount', 'volume_discount'], required: true },
    isActive: { type: Boolean, default: true, index: true },
    
    triggerItemId: { type: Schema.Types.ObjectId, ref: 'Item' },
    freeItemId: { type: Schema.Types.ObjectId, ref: 'Item' },
    minQuantity: { type: Number, default: 1 },
    
    itemIds: [{ type: Schema.Types.ObjectId, ref: 'Item' }],
    discountPercent: { type: Number, min: 0, max: 100 },
    discountAmount: { type: Number, min: 0 },
    
    applicableToTags: { type: [String], enum: ['first_time', 'regular', 'vip', 'corporate', 'seasonal'] },
    minOrderValue: Number,
    maxUsesPerCustomer: Number,
    validFrom: { type: Date, required: true },
    validTill: { type: Date, required: true },
  },
  { timestamps: true },
);

BundleSchema.index({ isActive: 1, validFrom: 1, validTill: 1 });
BundleSchema.index({ type: 1, isActive: 1 });

export const BundleModel = model<BundleDocument>('Bundle', BundleSchema);
