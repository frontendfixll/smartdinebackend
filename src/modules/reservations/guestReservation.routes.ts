import { z } from 'zod';
import { Router } from 'express';
import { validate } from '@middleware/validate';
import { guestWriteLimiter } from '@middleware/rateLimits';
import * as ctrl from './reservation.controller';
import * as v from './reservation.validators';

// Mounted at /guest/reservations — no auth, rate-limited.
const router = Router();

router.post('/', guestWriteLimiter, validate(v.createReservationSchema), ctrl.createGuest);

router.get('/:id', guestWriteLimiter, validate(v.idParamSchema, 'params'), ctrl.getGuest);
router.patch(
  '/:id',
  guestWriteLimiter,
  validate(v.idParamSchema, 'params'),
  validate(
    z.union([
      z.object({ cancel: z.literal(true) }).strict(),
      z
        .object({
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          time: z.string().regex(/^\d{2}:\d{2}$/),
          partySize: z.number().int().min(1).max(50),
        })
        .strict(),
    ]),
  ),
  ctrl.changeGuest,
);
export default router;
