import { Schema, model, Types } from 'mongoose';

export const DELIVERY_STATES = [
  'pending',
  'assigned',
  'dispatched',
  'delivered',
  'failed',
  'cancelled',
] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];
export interface DeliveryAddress {
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
}
const configSchema = new Schema(
  {
    singleton: { type: String, default: 'main', unique: true },
    enabled: { type: Boolean, default: false },
    postalCodes: { type: [String], default: [] },
    minimumOrder: { type: Number, min: 0, default: 0 },
    noAdditionalFee: { type: Boolean, default: false },
    instructions: { type: String, default: '' },
  },
  { timestamps: true },
);
export const DeliveryConfigModel = model('DeliveryConfig', configSchema);

const deliverySchema = new Schema(
  {
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true, unique: true },
    orderNumber: { type: String, required: true },
    guestName: { type: String, required: true },
    guestPhone: { type: String, required: true },
    address: { line1: String, line2: String, city: String, state: String, postalCode: String },
    instructions: String,
    status: { type: String, enum: DELIVERY_STATES, default: 'pending', required: true },
    driverId: { type: Schema.Types.ObjectId, ref: 'User' },
    driverName: String,
    currency: { type: String, required: true },
    total: { type: Number, required: true },
    deliveredAt: Date,
    events: [
      {
        status: { type: String, enum: DELIVERY_STATES, required: true },
        at: { type: Date, default: Date.now },
        actorId: { type: Schema.Types.ObjectId, required: true },
        note: String,
      },
    ],
  },
  { timestamps: true },
);
deliverySchema.index({ driverId: 1, status: 1 });
export const DeliveryModel = model('Delivery', deliverySchema);
export type DeliveryActor = { actorId: string; canManage: boolean };
export type DeliveryCreate = {
  orderId: string;
  guestName: string;
  guestPhone: string;
  address: DeliveryAddress;
  instructions?: string;
  addressConfirmed: true;
};
export type DeliveryChange = {
  status: DeliveryState;
  expectedStatus: DeliveryState;
  driverId?: string;
  note?: string;
  returnedToRestaurant?: boolean;
};
