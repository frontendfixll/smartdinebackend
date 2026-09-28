import { Router } from 'express';
import { validate } from '@middleware/validate';
import { requireGuestToken } from '@middleware/requireGuestToken';
import { requireOrderAccess } from '@middleware/requireOrderAccess';
import { guestWriteLimiter, publicReadLimiter } from '@middleware/rateLimits';
import * as ctrl from './guestOrder.controller';
import * as v from './order.validators';
import guestFeedbackRoutes from '@modules/feedback/guestFeedback.routes';
import { z } from 'zod';

const router = Router();
router.get('/now-serving', publicReadLimiter, ctrl.nowServing);
router.post('/quote', guestWriteLimiter, validate(v.addItemsSchema), ctrl.quote);
router.post('/dine-in', guestWriteLimiter, ctrl.placeDineIn);
router.post('/window', guestWriteLimiter, requireGuestToken, ctrl.placeWindow);
// Lookup requires the same private order capability; numbers are not passwords.
router.get('/by-number/:orderNumber', ctrl.getByOrderNumber);
router.use('/:id', validate(v.idParamSchema, 'params'), requireOrderAccess);
router.get('/:id', ctrl.getStatus);
router.post('/:id/items', guestWriteLimiter, ctrl.addItems);
router.post('/:id/requests', guestWriteLimiter, validate(v.guestRequestSchema), ctrl.sendRequest);
router.post(
  '/:id/pay-online',
  guestWriteLimiter,
  validate(
    z
      .object({
        tip: z
          .object({
            amount: z.number().min(0).max(10000).optional(),
            percent: z.number().min(0).max(100).optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
  ),
  ctrl.initiatePayment,
);
router.use('/:id/feedback', guestWriteLimiter, guestFeedbackRoutes);
export default router;
