import { listReservationsQuerySchema, idParamSchema } from './reservation.validators';
import { RESERVATION_STATUSES } from './reservation.model';
import { Router } from 'express';
import { requireAuth } from '@middleware/requireAuth';
import { requirePermission } from '@middleware/requirePermission';
import { validate } from '@middleware/validate';
import * as ctrl from './reservation.controller';
import { z } from 'zod';
import { mongoId } from '@utils/zod';

const router = Router();

const createSchema = z.object({
  guestName: z.string().min(2).max(100),
  guestPhone: z.string().regex(/^\+?[1-9]\d{7,14}$/),
  guestEmail: z.string().email().optional(),
  partySize: z.number().int().min(1).max(50),
  durationMinutes: z.number().int().min(15).max(360).optional(),
  reservedAt: z.union([z.string().datetime(), z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)]),
  notes: z.string().max(1000).optional(),
});

router.get(
  '/availability',
  requireAuth,
  requirePermission('reservation:read'),
  validate(
    z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      time: z.string().regex(/^\d{2}:\d{2}$/),
      partySize: z.coerce.number().int().min(1).max(50),
      durationMinutes: z.coerce.number().int().min(15).max(360).optional(),
      excludeId: mongoId().optional(),
    }),
    'query',
  ),
  ctrl.availability,
);
router.get('/waitlist', requireAuth, requirePermission('reservation:read'), ctrl.listWaitlist);
router.post(
  '/waitlist',
  requireAuth,
  requirePermission('reservation:create'),
  validate(createSchema.omit({ reservedAt: true, durationMinutes: true })),
  ctrl.createWaitlist,
);
router.get(
  '/',
  requireAuth,
  requirePermission('reservation:read'),
  validate(listReservationsQuerySchema, 'query'),
  ctrl.list,
);
router.patch(
  '/:id',
  requireAuth,
  requirePermission('reservation:update'),
  validate(idParamSchema, 'params'),
  validate(
    z
      .object({
        status: z.enum(RESERVATION_STATUSES),
        tableId: mongoId().optional(),
        durationMinutes: z.number().int().min(15).max(360).optional(),
        reason: z.string().max(500).optional(),
      })
      .strict(),
  ),
  ctrl.update,
);

router.post(
  '/',
  requireAuth,
  requirePermission('reservation:create'),
  validate(createSchema),
  ctrl.createReservation,
);
router.post(
  '/:id/check-in',
  requireAuth,
  requirePermission('reservation:update'),
  validate(idParamSchema, 'params'),
  validate(z.object({ tableId: mongoId().optional() })),
  ctrl.checkIn,
);
router.post(
  '/:id/complete',
  requireAuth,
  requirePermission('reservation:update'),
  validate(idParamSchema, 'params'),
  ctrl.complete,
);
router.post(
  '/:id/cancel',
  requireAuth,
  requirePermission('reservation:update'),
  validate(idParamSchema, 'params'),
  validate(z.object({ reason: z.string().optional() })),
  ctrl.cancel,
);
router.get('/upcoming', requireAuth, requirePermission('reservation:read'), ctrl.upcomingList);
router.get('/today', requireAuth, requirePermission('reservation:read'), ctrl.todayList);

export default router;
