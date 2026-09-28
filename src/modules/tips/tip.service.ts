import mongoose, { Types } from 'mongoose';
import { InvoiceModel } from '@modules/invoices/invoice.model';
import { ShiftModel } from '@modules/shifts/shift.model';
import { UserModel } from '@modules/users/user.model';
import { AuditLogModel } from '@modules/audit/auditLog.model';
import { getOrCreateRestaurant } from '@modules/restaurant/restaurant.service';
import { pacificDateTime } from '@utils/pacificDateTime';
import { allocate, fromMajor, toMajor } from '@utils/money';
import { AppError } from '@utils/AppError';
import { TipPayoutModel, TipPoolMethod } from './tipPayout.model';

interface ActorCtx {
  actorId?: string;
  actorEmail?: string;
  actorRole?: string;
  actorName?: string;
}

function assertBusinessDate(businessDate: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate))
    throw AppError.badRequest('Use a YYYY-MM-DD business date');
}

/** Pacific midnight-to-midnight window for a business day. */
function dayWindow(businessDate: string): { start: Date; end: Date } {
  const start = pacificDateTime(businessDate, '00:00');
  const noon = new Date(`${businessDate}T12:00:00Z`);
  noon.setUTCDate(noon.getUTCDate() + 1);
  const end = pacificDateTime(noon.toISOString().slice(0, 10), '00:00');
  return { start, end };
}

function overlapMs(aStart: number, aEnd: number, wStart: number, wEnd: number): number {
  return Math.max(0, Math.min(aEnd, wEnd) - Math.max(aStart, wStart));
}

/** Minutes a shift worked inside the window, excluding breaks that fall inside it. */
function workedMinutesInWindow(
  shift: { startedAt: Date; endedAt?: Date; breaks: { startedAt: Date; endedAt?: Date }[] },
  windowStart: number,
  windowEnd: number,
): number {
  const shiftEnd = (shift.endedAt ?? new Date(windowEnd)).getTime();
  const gross = overlapMs(shift.startedAt.getTime(), shiftEnd, windowStart, windowEnd);
  const breakMs = shift.breaks.reduce(
    (sum, b) =>
      sum +
      overlapMs(
        b.startedAt.getTime(),
        (b.endedAt ?? new Date(windowEnd)).getTime(),
        windowStart,
        windowEnd,
      ),
    0,
  );
  return Math.max(0, Math.floor((gross - breakMs) / 60000));
}

export interface TipPoolPreview {
  businessDate: string;
  method: TipPoolMethod;
  currency: string;
  totalTip: number;
  totalTipCents: number;
  allocations: Array<{
    userId: string;
    name: string;
    workedMinutes: number;
    amount: number;
    amountCents: number;
  }>;
  saved: boolean;
}

/**
 * Read-only preview of how a business day's collected tips would distribute across the
 * staff who worked that day. Distribution is exact to the cent (largest-remainder), by
 * worked minutes ('hours') or evenly ('equal'). This computes; it moves no money.
 */
export async function previewTipPool(
  businessDate: string,
  method: TipPoolMethod = 'hours',
): Promise<TipPoolPreview> {
  assertBusinessDate(businessDate);
  const restaurant = await getOrCreateRestaurant();
  const { start, end } = dayWindow(businessDate);
  const ws = start.getTime();
  const we = end.getTime();

  // Gross tips on finalized invoices billed that Pacific day.
  const [tipAgg] = await InvoiceModel.aggregate<{ tip: number }>([
    { $match: { status: 'final', issueDate: { $gte: start, $lt: end } } },
    { $group: { _id: null, tip: { $sum: '$tip' } } },
  ]);
  const totalTipCents = fromMajor(Math.round((tipAgg?.tip ?? 0) * 100) / 100);

  // Staff who worked in the window (any shift overlapping it).
  const shifts = await ShiftModel.find({
    startedAt: { $lt: end },
    $or: [{ endedAt: { $gte: start } }, { endedAt: { $exists: false } }],
  }).lean();

  const byUser = new Map<string, number>();
  for (const shift of shifts) {
    const minutes = workedMinutesInWindow(shift, ws, we);
    if (minutes <= 0) continue;
    const key = String(shift.userId);
    byUser.set(key, (byUser.get(key) ?? 0) + minutes);
  }

  const staff = [...byUser.entries()].map(([userId, workedMinutes]) => ({ userId, workedMinutes }));
  const users = await UserModel.find({ _id: { $in: staff.map((s) => new Types.ObjectId(s.userId)) } })
    .select('_id name')
    .lean();
  const nameOf = new Map(users.map((u) => [String(u._id), u.name]));

  const weights =
    method === 'equal' ? staff.map(() => 1) : staff.map((s) => s.workedMinutes);
  const shares = staff.length ? allocate(totalTipCents, weights) : [];

  return {
    businessDate,
    method,
    currency: restaurant.currency,
    totalTip: toMajor(totalTipCents),
    totalTipCents,
    allocations: staff.map((s, i) => ({
      userId: s.userId,
      name: nameOf.get(s.userId) ?? 'Unknown',
      workedMinutes: s.workedMinutes,
      amountCents: shares[i] ?? 0,
      amount: toMajor(shares[i] ?? 0),
    })),
    saved: Boolean(await TipPayoutModel.exists({ businessDate })),
  };
}

/** Persist an immutable tip payout snapshot for a business day (one per day). */
export async function saveTipPool(businessDate: string, method: TipPoolMethod, ctx: ActorCtx) {
  assertBusinessDate(businessDate);
  const preview = await previewTipPool(businessDate, method);
  return mongoose.connection.transaction(async (session) => {
    const existing = await TipPayoutModel.findOne({ businessDate }).session(session);
    if (existing) throw AppError.conflict('A tip payout for this day already exists');
    const [payout] = await TipPayoutModel.create(
      [
        {
          businessDate,
          method,
          currency: preview.currency,
          totalTip: preview.totalTip,
          allocations: preview.allocations.map((a) => ({
            userId: new Types.ObjectId(a.userId),
            name: a.name,
            workedMinutes: a.workedMinutes,
            amount: a.amount,
          })),
          generatedById: ctx.actorId ? new Types.ObjectId(ctx.actorId) : undefined,
          generatedByName: ctx.actorName ?? ctx.actorEmail,
        },
      ],
      { session },
    );
    await AuditLogModel.create(
      [
        {
          ...ctx,
          action: 'tips.payout',
          entity: 'TipPayout',
          entityId: String(payout._id),
          metadata: { businessDate, method, totalTip: preview.totalTip },
          at: new Date(),
        },
      ],
      { session },
    );
    return payout;
  });
}

export async function listTipPayouts(limit = 60) {
  return TipPayoutModel.find().sort({ businessDate: -1 }).limit(Math.min(200, limit)).lean();
}

export async function getTipPayout(businessDate: string) {
  assertBusinessDate(businessDate);
  return TipPayoutModel.findOne({ businessDate }).lean();
}
