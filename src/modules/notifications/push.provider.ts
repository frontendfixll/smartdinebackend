import { Types } from 'mongoose';
import webpush from 'web-push';
import { AppError } from '@utils/AppError';
import { PushSubscriptionModel, PushSubscriptionDocument } from './pushSubscription.model';
import { writeAuditLog } from '@modules/audit/audit.service';

const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@smartdine.local';

export interface PushPayload {
  title: string;
  body: string;
  icon?: string;
  badge?: string;
  tag?: string;
  data?: Record<string, string>;
}

export async function initializeWebPush() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;

  if (!publicKey || !privateKey) {
    console.warn(
      '⚠️  VAPID keys not configured. Push notifications disabled. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in .env',
    );
    return { publicKey: undefined, privateKey: undefined };
  }

  webpush.setVapidDetails(VAPID_SUBJECT, publicKey, privateKey);
  return { publicKey, privateKey };
}

export function getVapidPublicKey(): string | undefined {
  return process.env.VAPID_PUBLIC_KEY;
}

export async function subscribePush(
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  userId?: string,
  userAgent?: string,
) {
  const existing = await PushSubscriptionModel.findOne({ endpoint: subscription.endpoint });
  if (existing) {
    existing.isActive = true;
    existing.userAgent = userAgent;
    if (userId) existing.userId = new Types.ObjectId(userId);
    await existing.save();
    return existing;
  }

  const doc = await PushSubscriptionModel.create({
    userId: userId ? userId : undefined,
    endpoint: subscription.endpoint,
    p256dh: subscription.keys.p256dh,
    auth: subscription.keys.auth,
    userAgent,
    isActive: true,
  });

  if (userId) {
    await writeAuditLog({
      actorId: userId,
      action: 'notification.push_subscribed',
      entity: 'PushSubscription',
      entityId: String(doc._id),
    });
  }

  return doc;
}

export async function unsubscribePush(endpoint: string, userId?: string) {
  const doc = await PushSubscriptionModel.findOne({ endpoint });
  if (doc) {
    doc.isActive = false;
    await doc.save();

    if (userId) {
      await writeAuditLog({
        actorId: userId,
        action: 'notification.push_unsubscribed',
        entity: 'PushSubscription',
        entityId: String(doc._id),
      });
    }
  }
}

export async function dispatchSingle(subscriptionId: string, payload: PushPayload) {
  if (!process.env.VAPID_PUBLIC_KEY) {
    throw AppError.conflict('Push notifications not configured');
  }

  const sub = await PushSubscriptionModel.findById(subscriptionId);
  if (!sub || !sub.isActive) {
    throw AppError.notFound('Push subscription not found or inactive');
  }

  try {
    await webpush.sendNotification(
      {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth },
      },
      JSON.stringify({
        title: payload.title,
        body: payload.body,
        icon: payload.icon || undefined,
        badge: payload.badge || undefined,
        tag: payload.tag || 'smartdine-notification',
        data: payload.data || {},
      }),
    );

    return { sent: true, subscriptionId };
  } catch (err: unknown) {
    const error = err as { statusCode?: number; body?: string };
    if (error.statusCode === 410) {
      sub.isActive = false;
      await sub.save();
      throw AppError.notFound('Push subscription expired (410)');
    }
    throw AppError.internal(`Push send failed: ${error.body || 'unknown error'}`);
  }
}

export async function dispatchToUser(userId: string, payload: PushPayload) {
  const subs = await PushSubscriptionModel.find({ userId, isActive: true });
  if (!subs.length) {
    return { sent: 0, skipped: 'no subscriptions' };
  }

  const results = await Promise.allSettled(
    subs.map((sub) => dispatchSingle(String(sub._id), payload)),
  );

  const sent = results.filter((r) => r.status === 'fulfilled').length;
  const failed = results.filter((r) => r.status === 'rejected').length;

  return { sent, failed, total: subs.length };
}
