import mongoose, { Types, ClientSession } from 'mongoose';
import { AuditLogModel } from '@modules/audit/auditLog.model';
import { LoyaltyConfigModel, LoyaltyConfigDocument } from './loyaltyConfig.model';
import {
  LoyaltyAccountModel,
  LoyaltyAccountDocument,
  LoyaltyHistoryType,
} from './loyaltyAccount.model';
import { OrderModel } from '@modules/orders/order.model';
import { CustomerModel } from '@modules/customers/customer.model';
import { AppError } from '@utils/AppError';
import { writeAuditLog } from '@modules/audit/audit.service';

interface ActorCtx {
  actorId?: string;
  actorEmail?: string;
  actorRole?: string;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export async function getConfig(session?: ClientSession): Promise<LoyaltyConfigDocument> {
  let cfg = await LoyaltyConfigModel.findOne({ singleton: 'main' }).session(session ?? null);
  if (!cfg) [cfg] = await LoyaltyConfigModel.create([{ singleton: 'main' }], { session });
  return cfg;
}

export async function updateConfig(
  input: Partial<{
    isActive: boolean;
    earnRate: number;
    redeemRate: number;
    minRedeem: number;
    maxRedeemPercent: number;
    earnOn: 'subtotal' | 'grand';
    excludeWhenDiscounted: boolean;
    pointsExpiryDays: number;
    welcomeBonus: number;
  }>,
  ctx: ActorCtx,
) {
  const cfg = await getConfig();
  const before = cfg.toObject();
  if (typeof input.isActive === 'boolean') cfg.isActive = input.isActive;
  if (input.earnRate !== undefined) cfg.earnRate = input.earnRate;
  if (input.redeemRate !== undefined) cfg.redeemRate = input.redeemRate;
  if (input.minRedeem !== undefined) cfg.minRedeem = input.minRedeem;
  if (input.maxRedeemPercent !== undefined) cfg.maxRedeemPercent = input.maxRedeemPercent;
  if (input.earnOn !== undefined) cfg.earnOn = input.earnOn;
  if (typeof input.excludeWhenDiscounted === 'boolean')
    cfg.excludeWhenDiscounted = input.excludeWhenDiscounted;
  if (input.pointsExpiryDays !== undefined) cfg.pointsExpiryDays = input.pointsExpiryDays;
  if (input.welcomeBonus !== undefined) cfg.welcomeBonus = input.welcomeBonus;
  await cfg.save();
  await writeAuditLog({
    ...ctx,
    action: 'loyalty.config.update',
    entity: 'LoyaltyConfig',
    entityId: String(cfg._id),
    before,
    after: cfg.toObject(),
  });
  return cfg.toObject();
}

async function getOrCreateAccount(
  customerId: Types.ObjectId | string,
  session?: ClientSession,
): Promise<LoyaltyAccountDocument> {
  const id = new Types.ObjectId(String(customerId));
  let acct = await LoyaltyAccountModel.findOne({ customerId: id }).session(session ?? null);
  if (acct) return acct;
  const cfg = await getConfig(session);
  [acct] = await LoyaltyAccountModel.create([{ customerId: id }], { session });
  if (cfg.welcomeBonus > 0 && cfg.isActive) {
    acct.points = cfg.welcomeBonus;
    acct.lifetimeEarned = cfg.welcomeBonus;
    acct.history.push({
      _id: new Types.ObjectId(),
      type: 'welcome',
      points: cfg.welcomeBonus,
      balanceAfter: cfg.welcomeBonus,
      reason: 'Welcome bonus',
      at: new Date(),
    });
    await acct.save({ session });
  }
  return acct;
}

export async function getAccount(customerId: string) {
  const customer = await CustomerModel.findById(customerId).select('_id name phone').lean();
  if (!customer) throw AppError.notFound('Customer not found');
  const acct = await getOrCreateAccount(customer._id);
  return { customer, account: acct.toObject() };
}

function logHistory(
  acct: LoyaltyAccountDocument,
  type: LoyaltyHistoryType,
  points: number,
  opts: { orderId?: Types.ObjectId; reason?: string; actorId?: string } = {},
) {
  acct.history.push({
    _id: new Types.ObjectId(),
    type,
    points,
    balanceAfter: acct.points,
    orderId: opts.orderId,
    reason: opts.reason,
    actorId: opts.actorId ? new Types.ObjectId(opts.actorId) : undefined,
    at: new Date(),
  });
}

export async function adjustPoints(
  customerId: string,
  delta: number,
  reason: string,
  ctx: ActorCtx,
) {
  const acct = await getOrCreateAccount(customerId);
  if (acct.points + delta < 0) throw AppError.badRequest('Adjustment would make balance negative');
  acct.points += delta;
  if (delta > 0) acct.lifetimeEarned += delta;
  logHistory(acct, 'adjusted', delta, { reason, actorId: ctx.actorId });
  await acct.save();
  await writeAuditLog({
    ...ctx,
    action: 'loyalty.adjust',
    entity: 'LoyaltyAccount',
    entityId: String(acct._id),
    metadata: { customerId, delta, reason },
  });
  return acct.toObject();
}

export interface LoyaltyRedeemInput {
  customerId: Types.ObjectId;
  pointsRequested: number;
  billGrand: number; // current grand BEFORE loyalty redemption
}

export interface LoyaltyRedeemResult {
  valid: boolean;
  reason?: string;
  pointsRedeemed: number;
  amount: number;
}

export async function previewRedeem(
  { customerId, pointsRequested, billGrand }: LoyaltyRedeemInput,
  session?: ClientSession,
): Promise<LoyaltyRedeemResult> {
  const cfg = await getConfig(session);
  if (!cfg.isActive || cfg.redeemRate <= 0)
    return { valid: false, reason: 'Loyalty disabled', pointsRedeemed: 0, amount: 0 };
  if (pointsRequested < cfg.minRedeem) {
    return {
      valid: false,
      reason: `Minimum ${cfg.minRedeem} points required`,
      pointsRedeemed: 0,
      amount: 0,
    };
  }
  const acct = await getOrCreateAccount(customerId, session);
  const available = acct.points;
  if (available < pointsRequested) {
    return { valid: false, reason: 'Not enough points', pointsRedeemed: 0, amount: 0 };
  }
  const maxRedeemValue = round2((billGrand * cfg.maxRedeemPercent) / 100);
  const requestedValue = round2(pointsRequested * cfg.redeemRate);
  const finalValue = Math.min(requestedValue, maxRedeemValue, billGrand);
  const finalPoints = Math.floor(finalValue / cfg.redeemRate);
  if (finalPoints < cfg.minRedeem) {
    return {
      valid: false,
      reason: `After cap, only ${finalPoints} points would apply (min ${cfg.minRedeem})`,
      pointsRedeemed: 0,
      amount: 0,
    };
  }
  return { valid: true, pointsRedeemed: finalPoints, amount: round2(finalPoints * cfg.redeemRate) };
}

export async function commitRedeem(
  customerId: Types.ObjectId,
  points: number,
  orderId: Types.ObjectId,
  ctx: ActorCtx = {},
  session?: ClientSession,
): Promise<LoyaltyAccountDocument> {
  if (!session)
    return mongoose.connection.transaction((transaction) =>
      commitRedeem(customerId, points, orderId, ctx, transaction),
    );
  const acct = await getOrCreateAccount(customerId, session);
  const prior = acct.history.find(
    (h) => h.type === 'redeemed' && String(h.orderId) === String(orderId),
  );
  if (prior) {
    if (prior.points !== -points)
      throw AppError.conflict('This order already redeemed a different number of points');
    return acct;
  }
  if (!Number.isInteger(points) || points <= 0 || acct.points < points)
    throw AppError.conflict('Insufficient valid points at commit time');
  acct.points -= points;
  acct.lifetimeRedeemed += points;
  logHistory(acct, 'redeemed', -points, { orderId, actorId: ctx.actorId });
  await acct.save({ session });
  await AuditLogModel.create(
    [
      {
        ...ctx,
        action: 'loyalty.redeem',
        entity: 'LoyaltyAccount',
        entityId: String(acct._id),
        metadata: { customerId: String(customerId), points, orderId: String(orderId) },
        at: new Date(),
      },
    ],
    { session },
  );
  return acct;
}

/**
 * Reverse loyalty effects of an order when it is refunded or voided: claw back points
 * earned on it and restore points it redeemed. Idempotent — a reversal marker per order
 * means replays are no-ops. Points balance is floored at zero (never negative).
 */
export async function reverseLoyaltyForOrder(
  orderId: Types.ObjectId | string,
  ctx: ActorCtx = {},
  session?: ClientSession,
): Promise<void> {
  if (!session) {
    await mongoose.connection.transaction((s) => reverseLoyaltyForOrder(orderId, ctx, s));
    return;
  }
  const oid = new Types.ObjectId(String(orderId));
  const acct = await LoyaltyAccountModel.findOne({
    history: { $elemMatch: { orderId: oid, type: { $in: ['earned', 'redeemed'] } } },
  }).session(session);
  if (!acct) return;

  const earnedMarker = `reversal:earned:${oid}`;
  const redeemMarker = `reversal:redeemed:${oid}`;
  const alreadyReversed = (marker: string) =>
    acct.history.some((h) => h.type === 'adjusted' && h.reason === marker);
  let changed = false;

  const earned = acct.history.find(
    (h) => h.type === 'earned' && String(h.orderId) === String(oid),
  );
  if (earned && earned.points > 0 && !alreadyReversed(earnedMarker)) {
    // Available balance may already be spent; claw back only what remains.
    const clawback = Math.min(earned.points, acct.points);
    acct.points -= clawback;
    acct.lifetimeEarned = Math.max(0, acct.lifetimeEarned - earned.points);
    logHistory(acct, 'adjusted', -clawback, {
      orderId: oid,
      reason: earnedMarker,
      actorId: ctx.actorId,
    });
    changed = true;
  }

  const redeemed = acct.history.find(
    (h) => h.type === 'redeemed' && String(h.orderId) === String(oid),
  );
  if (redeemed && redeemed.points < 0 && !alreadyReversed(redeemMarker)) {
    const restore = -redeemed.points; // redemptions are stored as negative points
    acct.points += restore;
    acct.lifetimeRedeemed = Math.max(0, acct.lifetimeRedeemed - restore);
    logHistory(acct, 'adjusted', restore, {
      orderId: oid,
      reason: redeemMarker,
      actorId: ctx.actorId,
    });
    changed = true;
  }

  if (!changed) return;
  await acct.save({ session });
  await AuditLogModel.create(
    [
      {
        ...ctx,
        action: 'loyalty.reversal',
        entity: 'LoyaltyAccount',
        entityId: String(acct._id),
        metadata: { orderId: String(oid) },
        at: new Date(),
      },
    ],
    { session },
  );
}

/**
 * Expire loyalty balances that have seen no earn/redeem activity within the configured
 * `pointsExpiryDays` window. Run by a daily job. Returns a summary for logging.
 * Idempotent by nature: a zero balance is skipped, so re-running does nothing extra.
 */
export async function expireStalePoints(): Promise<{
  expiredAccounts: number;
  expiredPoints: number;
}> {
  const cfg = await getConfig();
  if (!cfg.isActive || !cfg.pointsExpiryDays || cfg.pointsExpiryDays <= 0)
    return { expiredAccounts: 0, expiredPoints: 0 };
  const cutoff = new Date(Date.now() - cfg.pointsExpiryDays * 24 * 60 * 60 * 1000);
  const accounts = await LoyaltyAccountModel.find({ points: { $gt: 0 } });
  let expiredAccounts = 0;
  let expiredPoints = 0;
  for (const acct of accounts) {
    const lastActivity = acct.history.reduce((latest, h) => {
      if (h.type !== 'earned' && h.type !== 'redeemed' && h.type !== 'welcome') return latest;
      return h.at > latest ? h.at : latest;
    }, new Date(0));
    if (lastActivity >= cutoff) continue;
    const expiring = acct.points;
    acct.points = 0;
    logHistory(acct, 'expired', -expiring, {
      reason: `Expired after ${cfg.pointsExpiryDays} days of inactivity`,
    });
    await acct.save();
    expiredAccounts += 1;
    expiredPoints += expiring;
  }
  return { expiredAccounts, expiredPoints };
}

// Called from payment.service maybeSettleOrder via dynamic import
export async function earnPointsForOrder(orderId: Types.ObjectId | string) {
  const order = await OrderModel.findById(orderId).lean();
  if (!order || !order.customerId) return;
  if (order.status !== 'settled') return;
  const cfg = await getConfig();
  if (!cfg.isActive) return;
  if (cfg.excludeWhenDiscounted && order.totals.discount > 0) return;

  const base =
    cfg.earnOn === 'grand'
      ? order.totals.grand
      : order.totals.subtotal + order.totals.modifierTotal;
  const points = Math.floor(base / cfg.earnRate);
  if (points <= 0) return;

  const acct = await getOrCreateAccount(order.customerId);
  const historyEntry = {
    _id: new Types.ObjectId(),
    type: 'earned' as LoyaltyHistoryType,
    points,
    balanceAfter: acct.points + points,
    orderId: order._id,
    reason: `Order ${order.orderNumber}`,
    at: new Date(),
  };
  // Atomic: filter ensures only one concurrent call can insert the earned entry for this order.
  // If modifiedCount === 0 the entry already exists (idempotent).
  const result = await LoyaltyAccountModel.updateOne(
    {
      _id: acct._id,
      history: { $not: { $elemMatch: { type: 'earned', orderId: order._id } } },
    },
    {
      $inc: { points, lifetimeEarned: points },
      $push: { history: historyEntry },
    },
  );
  if (result.modifiedCount === 0) return;
}
