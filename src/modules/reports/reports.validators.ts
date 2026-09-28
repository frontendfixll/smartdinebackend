import { pacificDateTime } from '@utils/pacificDateTime';
import { z } from 'zod';

export const baseRange = z.object({
  from: z
    .preprocess(
      (v) =>
        typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? pacificDateTime(v, '00:00') : v,
      z.coerce.date(),
    )
    .optional(),
  to: z
    .preprocess(
      (v) =>
        typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
          ? new Date(pacificDateTime(v, '23:59').getTime() + 59999)
          : v,
      z.coerce.date(),
    )
    .optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
});

export const salesQuerySchema = baseRange.extend({
  groupBy: z.enum(['day', 'week', 'month']).optional(),
  channel: z.enum(['dine_in', 'window', 'assisted']).optional(),
});

export const itemsQuerySchema = baseRange.extend({
  sortBy: z.enum(['top', 'slow']).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

export const exportParamSchema = z.object({
  type: z.enum([
    'sales',
    'items',
    'tax',
    'payments',
    'staff',
    'footfall',
    'inventory',
    'feedback',
    'profitability',
  ]),
});

export const exportQuerySchema = z
  .object({
    format: z.enum(['csv', 'xlsx', 'pdf']).default('csv'),
  })
  .merge(salesQuerySchema)
  .merge(itemsQuerySchema);
