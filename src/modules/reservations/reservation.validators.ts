import { z } from 'zod';
import { mongoId, hhmm } from '@utils/zod';
import { RESERVATION_STATUSES } from './reservation.model';

const yyyymmdd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const createReservationSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email().max(200),
  phone: z.string().min(4).max(40).optional(),
  date: yyyymmdd,
  time: hhmm(),
  partySize: z.number().int().min(1).max(50),
  seatingPreference: z.string().min(1).max(80).optional(),
  notes: z.string().max(1000).optional(),
});

export const updateReservationSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    email: z.string().email().max(200).optional(),
    phone: z.string().min(4).max(40).optional(),
    date: yyyymmdd.optional(),
    time: hhmm().optional(),
    partySize: z.number().int().min(1).max(50).optional(),
    seatingPreference: z.string().min(1).max(80).optional(),
    notes: z.string().max(1000).optional(),
    status: z.enum(RESERVATION_STATUSES).optional(),
    tableId: mongoId().optional(),
  })
  .strict();

export const listReservationsQuerySchema = z.object({
  status: z.enum(RESERVATION_STATUSES).optional(),
  from: yyyymmdd.optional(),
  to: yyyymmdd.optional(),
  q: z.string().min(1).max(80).optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

export const idParamSchema = z.object({ id: mongoId() });
