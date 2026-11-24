import { ClientSession, Schema, Types, model } from 'mongoose';
import { TableSessionModel } from '@modules/tables/tableSession.model';
import { getIo } from '@sockets/index';
import { dispatchToUser } from '@modules/notifications/push.provider';

const Notice = model(
  'TableServiceNotice',
  new Schema(
    {
      visit: { type: Schema.Types.ObjectId, required: true },
      kind: { type: String, required: true },
      owner: Schema.Types.ObjectId,
      reason: String,
      previous: Schema.Types.ObjectId,
      actor: Schema.Types.ObjectId,
      publishedAt: Date,
      pushSent: Number,
      attempts: { type: Number, default: 0 },
      retryAt: { type: Date, default: Date.now, index: true },
    },
    { timestamps: true },
  ),
);
export async function recordNotice(
  session: ClientSession,
  visit: Types.ObjectId,
  kind: string,
  owner?: Types.ObjectId,
  actor?: string,
  previous?: string | null,
  reason?: string,
) {
  await Notice.create([{ visit, kind, owner, reason, previous: previous || undefined, actor }], {
    session,
  });
}
// The inbox is authoritative. A retry can repeat a wake-up after a worker crash.
export async function publishServiceNotices() {
  const pending = await Notice.find({ publishedAt: null, retryAt: { $lte: new Date() } })
    .sort({ retryAt: 1 })
    .limit(100);
  for (const n of pending) {
    const attempt = await Notice.findOneAndUpdate(
      { _id: n._id, publishedAt: null, retryAt: n.retryAt },
      {
        $inc: { attempts: 1 },
        $set: {
          retryAt: new Date(Date.now() + Math.min(30, 2 ** Math.min(5, n.attempts)) * 60000),
        },
      },
    );
    if (!attempt) continue;
    const active = await TableSessionModel.findOne({ _id: n.visit, status: 'open' }).lean();
    let sent = 0;
    if (active) {
      getIo()
        .of('/staff')
        .emit('table:service_changed', { tableId: String(active.tableId) });
      if (
        n.owner &&
        (active.waiterId?.equals(n.owner) ||
          (active.offerTo?.equals(n.owner) &&
            (active.offerExpiresAt?.getTime() ?? 0) > Date.now())) &&
        process.env.VAPID_PUBLIC_KEY &&
        process.env.VAPID_PRIVATE_KEY
      ) {
        const result = await dispatchToUser(String(n.owner), {
          title: 'Table service',
          body: 'Open your floor inbox for the latest table update.',
          tag: 'table-service-' + n.visit,
          data: { visitId: String(n.visit) },
        });
        sent = result.sent;
        if (!sent && result.failed) continue;
      }
    }
    await Notice.updateOne({ _id: n._id }, { $set: { publishedAt: new Date(), pushSent: sent } });
  }
}
