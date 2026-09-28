import { Router } from 'express';
import { requireAuth } from '@middleware/requireAuth';
import { requirePermission } from '@middleware/requirePermission';
import * as ctrl from './tip.controller';

const router = Router();

router.use(requireAuth);

router.get('/payouts', requirePermission('tips:read'), ctrl.list);
router.get('/pool/preview', requirePermission('tips:read'), ctrl.preview);
router.get('/payouts/:businessDate', requirePermission('tips:read'), ctrl.getOne);
router.post('/payouts', requirePermission('tips:manage'), ctrl.save);

export default router;
