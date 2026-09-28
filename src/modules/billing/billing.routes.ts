import { z } from 'zod';
import { Router } from 'express';
import { requireAuth } from '@middleware/requireAuth';
import { requirePermission } from '@middleware/requirePermission';
import { validate } from '@middleware/validate';
import { generateForOrder, getForOrder } from '@modules/invoices/invoice.controller';
import { generateInvoiceSchema, orderIdParamSchema } from '@modules/invoices/invoice.validators';
import * as dayCloseCtrl from './dayClose.controller';

const router = Router();
router.use(requireAuth);
router.get(
  '/orders/:id/bill',
  requirePermission('billing:read'),
  validate(orderIdParamSchema, 'params'),
  getForOrder,
);

// Generate (or refresh) an invoice from an order.
router.post(
  '/orders/:id/bill',
  requirePermission('billing:create'),
  validate(orderIdParamSchema, 'params'),
  validate(generateInvoiceSchema),
  generateForOrder,
);

// Day-close
router.get('/day-close/history', requirePermission('day:close'), dayCloseCtrl.history);
router.get(
  '/day-close/preview',
  requirePermission('day:close'),
  validate(
    z.object({
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
    }),
    'query',
  ),
  dayCloseCtrl.preview,
);
router.post(
  '/day-close',
  requirePermission('day:close'),
  validate(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })),
  dayCloseCtrl.close,
);
router.post(
  '/day-close/reopen',
  requirePermission('day:close'),
  validate(
    z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      reason: z.string().min(1).max(300),
    }),
  ),
  dayCloseCtrl.reopen,
);

export default router;
