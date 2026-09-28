import { Schema, model, Document, Types } from 'mongoose';

export interface LoyaltyConfigDocument extends Document {
  _id: Types.ObjectId;
  singleton: 'main';
  isActive: boolean;
  earnRate: number; // Units of configured currency spent per point earned
  redeemRate: number; // Configured currency value per point redeemed
  minRedeem: number; // minimum points required to redeem
  maxRedeemPercent: number; // cap on % of bill that loyalty can cover
  earnOn: 'subtotal' | 'grand'; // base for point calculation
  excludeWhenDiscounted: boolean;
  pointsExpiryDays?: number;
  welcomeBonus: number;
  createdAt: Date;
  updatedAt: Date;
}

const LoyaltyConfigSchema = new Schema<LoyaltyConfigDocument>(
  {
    singleton: { type: String, enum: ['main'], default: 'main', unique: true, required: true },
    isActive: { type: Boolean, default: false },
    earnRate: { type: Number, default: 10, min: 1 },
    redeemRate: { type: Number, default: 1, min: 0 },
    minRedeem: { type: Number, default: 100, min: 0 },
    maxRedeemPercent: { type: Number, default: 50, min: 0, max: 100 },
    earnOn: { type: String, enum: ['subtotal', 'grand'], default: 'subtotal' },
    excludeWhenDiscounted: { type: Boolean, default: false },
    pointsExpiryDays: Number,
    welcomeBonus: { type: Number, default: 0 },
  },
  { timestamps: true },
);

export const LoyaltyConfigModel = model<LoyaltyConfigDocument>(
  'LoyaltyConfig',
  LoyaltyConfigSchema,
);
