import { Router } from 'express';
import { validate } from '@middleware/validate';
import { requireAuth } from '@middleware/requireAuth';
import * as ctrl from './billShare.controller';
import { z } from 'zod';
import { mongoId } from '@utils/zod';

const router = Router();
router.use(requireAuth);

const shareSchema = z.object({
  invoiceId: mongoId(),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  channel: z.enum(['whatsapp', 'sms', 'email']),
});

router.post('/share', validate(shareSchema), ctrl.shareBill);
router.get('/:invoiceId/shares', validate(z.object({ invoiceId: mongoId() }), 'params'), ctrl.getBillShares);

export default router;
