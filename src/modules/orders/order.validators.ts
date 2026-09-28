import { z } from 'zod';
import { mongoId } from '@utils/zod';

const itemInputSchema = z
  .object({
    itemId: mongoId().optional(),
    comboId: mongoId().optional(),
    variantId: mongoId().optional(),
    qty: z.number().int().min(1).max(50),
    notes: z.string().max(300).optional(),
    modifiers: z
      .array(z.object({ groupId: mongoId(), modifierId: mongoId() }))
      .max(20)
      .optional(),
  })
  .refine((v) => Boolean(v.itemId) !== Boolean(v.comboId), {
    message: 'Provide exactly one itemId or comboId',
  });

export const placeAssistedSchema = z.object({
  maxTotal: z.number().finite().nonnegative().optional(),
  channel: z.enum(['dine_in', 'assisted']).optional(),
  tableId: mongoId().optional(),
  customerId: mongoId().optional(),
  guestPhone: z
    .string()
    .regex(/^\+?[1-9]\d{7,14}$/)
    .optional(),
  guestName: z.string().min(1).max(120).optional(),
  guestNotes: z.string().max(500).optional(),
  items: z.array(itemInputSchema).min(1).max(50),
  couponCode: z.string().max(40).optional(),
});

export const placeDineInGuestSchema = z.object({
  qrSlug: z.string().min(3).max(20),
  maxTotal: z.number().finite().nonnegative(),
  guestPhone: z
    .string()
    .regex(/^\+?[1-9]\d{7,14}$/)
    .optional(),
  guestName: z.string().min(1).max(120).optional(),
  guestNotes: z.string().max(500).optional(),
  items: z.array(itemInputSchema).min(1).max(50),
  couponCode: z.string().max(40).optional(),
});

export const placeWindowGuestSchema = z.object({
  maxTotal: z.number().finite().nonnegative(),
  qrSlug: z.string().min(3).max(20).optional(),
  guestName: z.string().min(1).max(120).optional(),
  guestNotes: z.string().max(500).optional(),
  pickupAt: z
    .string()
    .datetime({ offset: true })
    .transform((value) => new Date(value))
    .optional(),
  pickupLocal: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
    .optional(),
  items: z.array(itemInputSchema).min(1).max(50),
  couponCode: z.string().max(40).optional(),
});

export const addItemsSchema = z.object({
  items: z.array(itemInputSchema).min(1).max(50),
  maxTotal: z.number().finite().nonnegative().optional(),
});

export const voidItemSchema = z.object({
  reason: z.string().min(3).max(300),
});

export const cancelOrderSchema = z.object({
  reason: z.string().min(3).max(300),
});

export const guestRequestSchema = z.object({
  type: z.enum(['call_waiter', 'water', 'bill', 'other']),
  message: z.string().max(200).optional(),
});

export const windowTokenScanSchema = z.object({
  windowToken: z.string().min(3).max(20),
});

export const listOrdersQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z
    .enum(['placed', 'accepted', 'preparing', 'ready', 'served', 'settled', 'cancelled'])
    .optional(),
  channel: z.enum(['dine_in', 'window', 'assisted']).optional(),
  tableId: mongoId().optional(),
  waiterId: mongoId().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

export const idParamSchema = z.object({ id: mongoId() });
export const orderItemParamSchema = z.object({ id: mongoId(), itemId: mongoId() });
export const requestParamSchema = z.object({ id: mongoId(), requestId: mongoId() });
