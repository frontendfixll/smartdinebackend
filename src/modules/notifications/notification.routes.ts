import { Router } from 'express';
import { validate } from '@middleware/validate';
import { requireAuth } from '@middleware/requireAuth';
import { requirePermission } from '@middleware/requirePermission';
import * as ctrl from './notification.controller';
import * as v from './notification.validators';
import { z } from 'zod';

const router = Router();

const pushSubscriptionSchema = z.object({
  subscription: z.object({
    endpoint: z.string().url(),
    keys: z.object({
      p256dh: z.string(),
      auth: z.string(),
    }),
  }),
});

const unsubscribeSchema = z.object({
  endpoint: z.string().url(),
});

router.get('/vapid-key', ctrl.getVapidKey);
router.post('/subscribe', validate(pushSubscriptionSchema), ctrl.subscribePushNotifications);
router.post('/unsubscribe', validate(unsubscribeSchema), ctrl.unsubscribePushNotifications);

router.use(requireAuth);
router.get('/events', requirePermission('notification:read'), ctrl.listEvents);
router.get(
  '/templates',
  requirePermission('notification:read'),
  validate(v.listTemplatesQuerySchema, 'query'),
  ctrl.listTemplates,
);
router.get(
  '/logs',
  requirePermission('notification:read'),
  validate(v.listLogsQuerySchema, 'query'),
  ctrl.listLogs,
);
router.post(
  '/templates/preview',
  requirePermission('notification:template'),
  validate(v.previewSchema),
  ctrl.previewTemplate,
);
router.post(
  '/templates',
  requirePermission('notification:template'),
  validate(v.createTemplateSchema),
  ctrl.createTemplate,
);
router.patch(
  '/templates/:id',
  requirePermission('notification:template'),
  validate(v.idParamSchema, 'params'),
  validate(v.updateTemplateSchema),
  ctrl.updateTemplate,
);
router.delete(
  '/templates/:id',
  requirePermission('notification:template'),
  validate(v.idParamSchema, 'params'),
  ctrl.deleteTemplate,
);
router.post(
  '/test',
  requirePermission('notification:send'),
  validate(v.testSendSchema),
  ctrl.testSend,
);

export default router;
