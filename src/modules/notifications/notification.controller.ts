import { Request, Response } from 'express';
import { asyncHandler } from '@utils/asyncHandler';
import { ok, created, paginated } from '@utils/apiResponse';
import { AppError } from '@utils/AppError';
import { getVapidPublicKey, subscribePush, unsubscribePush } from './push.provider';
import * as templates from './template.service';
import { listLogs as readLogs, ListLogsOpts } from './log.service';
import { dispatchNotification } from './notification.service';
import { findEvent } from './events';

const actor = (req: Request) => ({
  actorId: req.user?.id,
  actorEmail: req.user?.email,
  actorRole: req.user?.role.key,
});

export const listEvents = asyncHandler(async (_req: Request, res: Response) =>
  ok(res, await templates.listEvents()),
);
export const listTemplates = asyncHandler(async (req: Request, res: Response) =>
  ok(
    res,
    await templates.listTemplates(req.query as Parameters<typeof templates.listTemplates>[0]),
  ),
);
export const createTemplate = asyncHandler(async (req: Request, res: Response) =>
  created(res, await templates.createTemplate(req.body, actor(req))),
);
export const updateTemplate = asyncHandler(async (req: Request, res: Response) =>
  ok(res, await templates.updateTemplate(req.params.id, req.body, actor(req))),
);
export const deleteTemplate = asyncHandler(async (req: Request, res: Response) => {
  await templates.deleteTemplate(req.params.id, actor(req));
  return ok(res, { deleted: true });
});
export const previewTemplate = asyncHandler(async (req: Request, res: Response) =>
  ok(res, await templates.previewTemplate(req.body)),
);
export const listLogs = asyncHandler(async (req: Request, res: Response) => {
  const { items, meta } = await readLogs(req.query as ListLogsOpts);
  return paginated(res, items, meta);
});
export const testSend = asyncHandler(async (req: Request, res: Response) => {
  const event = findEvent(req.body.eventKey);
  if (!event || (req.body.channel && !event.channels.includes(req.body.channel)))
    throw AppError.badRequest('Choose a supported event and channel');
  return ok(res, await dispatchNotification({ ...req.body, triggeredById: req.user?.id }));
});

export const getVapidKey = asyncHandler(async (_req: Request, res: Response) => {
  const publicKey = getVapidPublicKey();
  if (!publicKey) {
    throw AppError.conflict('Push notifications not configured');
  }
  return ok(res, { publicKey });
});

export const subscribePushNotifications = asyncHandler(async (req: Request, res: Response) => {
  const { subscription } = req.body;
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    throw AppError.badRequest('Invalid push subscription format');
  }

  const doc = await subscribePush(subscription, req.user?.id, req.headers['user-agent']);

  return created(res, { subscriptionId: String(doc._id), subscribed: true });
});

export const unsubscribePushNotifications = asyncHandler(async (req: Request, res: Response) => {
  const { endpoint } = req.body;
  if (!endpoint) {
    throw AppError.badRequest('Missing endpoint');
  }

  await unsubscribePush(endpoint, req.user?.id);
  return ok(res, { unsubscribed: true });
});
