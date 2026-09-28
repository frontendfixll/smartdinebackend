import { Schema, model, Document, Types } from 'mongoose';

export const RESERVATION_STATUSES = [
  'pending',
  'confirmed',
  'checked_in',
  'completed',
  'cancelled',
  'no_show',
] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

export interface ReservationDocument extends Document {
  _id: Types.ObjectId;
  restaurantId: Types.ObjectId;
  kind: 'reservation' | 'waitlist';
  durationMinutes: number;
  endsAt?: Date;
  tableSessionId?: Types.ObjectId;
  guestName: string;
  guestPhone?: string;
  guestEmail?: string;
  partySize: number;
  reservedAt: Date;
  status: ReservationStatus;
  tableId?: Types.ObjectId;
  notes?: string;
  checkedInAt?: Date;
  completedAt?: Date;
  cancelledAt?: Date;
  cancellationReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ReservationSchema = new Schema<ReservationDocument>(
  {
    restaurantId: { type: Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    kind: { type: String, enum: ['reservation', 'waitlist'], default: 'reservation', index: true },
    durationMinutes: { type: Number, default: 90, min: 15, max: 360 },
    endsAt: Date,
    tableSessionId: { type: Schema.Types.ObjectId, ref: 'TableSession' },
    guestName: { type: String, required: true, trim: true },
    guestPhone: { type: String, index: true },
    guestEmail: { type: String, trim: true },
    partySize: { type: Number, required: true, min: 1 },
    reservedAt: { type: Date, required: true, index: true },
    status: {
      type: String,
      enum: ['pending', 'confirmed', 'checked_in', 'completed', 'cancelled', 'no_show'],
      default: 'pending',
      index: true,
    },
    tableId: { type: Schema.Types.ObjectId, ref: 'Table' },
    notes: String,
    checkedInAt: Date,
    completedAt: Date,
    cancelledAt: Date,
    cancellationReason: String,
  },
  { timestamps: true },
);

ReservationSchema.index({ restaurantId: 1, reservedAt: -1 });
ReservationSchema.index({ guestPhone: 1, restaurantId: 1 });
ReservationSchema.index({ tableId: 1, status: 1 });

export const ReservationModel = model<ReservationDocument>('Reservation', ReservationSchema);
