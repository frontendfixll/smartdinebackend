import { Schema, model } from 'mongoose';

export const ServiceTask = model(
  'VisitServiceTask',
  new Schema(
    {
      visit: { type: Schema.Types.ObjectId, required: true, index: true },
      type: { type: String, enum: ['water', 'help', 'bill'], required: true },
      state: {
        type: String,
        enum: ['requested', 'acknowledged', 'completed', 'cancelled'],
        default: 'requested',
      },
      requestKeys: { type: [String], required: true },
      acknowledgedBy: Schema.Types.ObjectId,
      completedBy: Schema.Types.ObjectId,
      acknowledgedAt: Date,
      completedAt: Date,
      cancelledAt: Date,
      cancelledBy: Schema.Types.ObjectId,
    },
    { timestamps: true },
  ).index({ visit: 1, requestKeys: 1 }, { unique: true }),
);
