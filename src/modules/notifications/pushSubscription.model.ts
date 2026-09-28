import { Schema, model, Document, Types } from 'mongoose';

export interface PushSubscriptionDocument extends Document {
  _id: Types.ObjectId;
  userId?: Types.ObjectId;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const PushSubscriptionSchema = new Schema<PushSubscriptionDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    endpoint: { type: String, required: true, unique: true, index: true },
    p256dh: { type: String, required: true },
    auth: { type: String, required: true },
    userAgent: String,
    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true },
);

export const PushSubscriptionModel = model<PushSubscriptionDocument>(
  'PushSubscription',
  PushSubscriptionSchema,
);
