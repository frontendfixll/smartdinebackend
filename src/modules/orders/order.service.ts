import { grantedVisit } from '@modules/tableService/membership';
import { pilotZone } from '@modules/tableService/assignment';
import { AuditLogModel } from '@modules/audit/auditLog.model';
import mongoose, { Types } from 'mongoose';
import { OrderModel, OrderDocument, OrderItem, OrderItemStatus, OrderStatus } from './order.model';
import { ItemModel } from '@modules/menu/item.model';
import { ComboModel } from '@modules/menu/combo.model';
import { ModifierGroupModel } from '@modules/menu/modifierGroup.model';
import { TableModel } from '@modules/tables/table.model';
import { TableSessionModel } from '@modules/tables/tableSession.model';
import { QrCodeModel } from '@modules/qr/qrCode.model';
import { getOrCreateRestaurant } from '@modules/restaurant/restaurant.service';
import { AppError } from '@utils/AppError';
import { writeAuditLog } from '@modules/audit/audit.service';
import { computeTotals, estimatePrepMinutes } from './pricing';
import { nextOrderNumber, nextWindowToken } from './numbering';
import { validateCoupon, recordCouponRedemption } from '@modules/promotions/coupon.service';
import {
  emitToStaff,
  emitToKdsStation,
  emitToKdsAll,
  emitToGuestOrder,
  emitToNowServing,
} from './orderEvents';
import { completeOrderRequest, OrderRequest } from './orderRequest.service';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

interface ActorCtx {
  actorId?: string;
  actorEmail?: string;
  actorRole?: string;
  actorName?: string;
}

export interface ItemInput {
  itemId?: string;
  comboId?: string;
  variantId?: string;
  qty: number;
  notes?: string;
  modifiers?: Array<{ groupId: string; modifierId: string }>;
}

interface ResolvedItem {
  build: Omit<OrderItem, '_id' | 'lineTotal'>;
  /** Carried alongside `build` (not persisted on the order item) so coupon/discount
   *  eligibility can be evaluated by category or item without a second DB lookup. */
  itemId?: Types.ObjectId;
  categoryId?: Types.ObjectId;
}

async function resolveItems(inputs: ItemInput[]): Promise<ResolvedItem[]> {
  if (!inputs.length) throw AppError.badRequest('Order must contain at least one item');
  const itemIds = inputs.filter((i) => i.itemId).map((i) => i.itemId!) as string[];
  const comboIds = inputs.filter((i) => i.comboId).map((i) => i.comboId!) as string[];
  const [items, combos] = await Promise.all([
    itemIds.length ? ItemModel.find({ _id: { $in: itemIds } }).lean() : [],
    comboIds.length ? ComboModel.find({ _id: { $in: comboIds } }).lean() : [],
  ]);
  const itemById = new Map(items.map((i) => [String(i._id), i]));
  const comboById = new Map(combos.map((c) => [String(c._id), c]));

  const modGroupIds = new Set<string>();
  for (const item of items) for (const id of item.modifierGroupIds) modGroupIds.add(String(id));
  for (const inp of inputs) for (const m of inp.modifiers ?? []) modGroupIds.add(m.groupId);
  const modGroups = modGroupIds.size
    ? await ModifierGroupModel.find({ _id: { $in: Array.from(modGroupIds) } }).lean()
    : [];
  const modGroupById = new Map(modGroups.map((g) => [String(g._id), g]));

  const resolved: ResolvedItem[] = [];
  for (const inp of inputs) {
    if (!inp.itemId && !inp.comboId) throw AppError.badRequest('Each line needs itemId or comboId');
    if (inp.qty < 1) throw AppError.badRequest('Quantity must be >= 1');

    if (inp.itemId) {
      const item = itemById.get(inp.itemId);
      if (!item) throw AppError.badRequest(`Item not found: ${inp.itemId}`);
      if (item.is86 || !item.isActive) throw AppError.conflict(`Item unavailable: ${item.name}`);

      let basePrice = item.basePrice;
      let variantName: string | undefined;
      let variantId: Types.ObjectId | undefined;
      if (item.pizzaBuilder?.enabled && item.variants.length && !inp.variantId) {
        throw AppError.badRequest('Choose an available pizza size');
      }
      if (inp.variantId) {
        const variant = item.variants.find((v) => String(v._id) === inp.variantId);
        if (!variant) throw AppError.badRequest(`Variant not found for ${item.name}`);
        if (variant.is86) throw AppError.conflict(`Variant unavailable: ${variant.name}`);
        basePrice = variant.absolutePrice ?? item.basePrice + variant.priceDelta;
        variantName = variant.name;
        variantId = variant._id;
      }

      const modifiers = (inp.modifiers ?? []).map((m) => {
        const g = modGroupById.get(m.groupId);
        if (!g || !g.isActive)
          throw AppError.badRequest(`Modifier group unavailable: ${m.groupId}`);
        if (!item.modifierGroupIds.some((id) => String(id) === m.groupId)) {
          throw AppError.badRequest(
            `Modifier group "${g.name}" not attached to item "${item.name}"`,
          );
        }
        const mod = g.modifiers.find((md) => String(md._id) === m.modifierId);
        if (!mod) throw AppError.badRequest(`Modifier not found in group "${g.name}"`);
        if (mod.is86) throw AppError.conflict(`Modifier unavailable: ${mod.name}`);
        return {
          groupId: g._id,
          groupName: g.name,
          modifierId: mod._id,
          modifierName: mod.name,
          priceDelta: mod.priceDelta,
        };
      });

      const groupedCounts = new Map<string, number>();
      const uniqueSelections = new Set(modifiers.map((m) => `${m.groupId}:${m.modifierId}`));
      if (uniqueSelections.size !== modifiers.length)
        throw AppError.badRequest('A modifier cannot be selected twice');
      for (const m of modifiers) {
        const k = String(m.groupId);
        groupedCounts.set(k, (groupedCounts.get(k) ?? 0) + 1);
      }
      for (const g of modGroups) {
        const c = groupedCounts.get(String(g._id)) ?? 0;
        if (item.modifierGroupIds.some((id) => String(id) === String(g._id))) {
          if (g.isRequired && c < Math.max(1, g.minSelections)) {
            throw AppError.badRequest(
              `Group "${g.name}" requires at least ${Math.max(1, g.minSelections)} selection(s)`,
            );
          }
          if (c > g.maxSelections) {
            throw AppError.badRequest(
              `Group "${g.name}" allows at most ${g.maxSelections} selection(s)`,
            );
          }
        }
      }

      resolved.push({
        build: {
          itemId: item._id,
          variantId,
          name: item.name,
          variantName,
          qty: inp.qty,
          basePrice,
          modifiers,
          notes: inp.notes,
          station: item.station,
          status: 'pending',
        },
        itemId: item._id,
        categoryId: item.categoryId,
      });
    } else {
      const combo = comboById.get(inp.comboId!);
      if (!combo) throw AppError.badRequest(`Combo not found: ${inp.comboId}`);
      if (combo.is86 || !combo.isActive)
        throw AppError.conflict(`Combo unavailable: ${combo.name}`);
      if (combo.modifierGroupIds.length || inp.modifiers?.length)
        throw AppError.badRequest('This combo requires staff customization');

      // Validate all member items inside the combo are still available
      if (combo.items.length > 0) {
        const memberIds = combo.items.map((ci) => ci.itemId);
        const memberDocs = await ItemModel.find({ _id: { $in: memberIds } })
          .select('name is86 isActive variants')
          .lean();
        if (memberDocs.length < new Set(memberIds.map(String)).size) {
          throw AppError.conflict(`Combo "${combo.name}" contains items that no longer exist`);
        }
        for (const mi of memberDocs) {
          if (mi.is86 || !mi.isActive) {
            throw AppError.conflict(`Combo "${combo.name}" contains unavailable item: ${mi.name}`);
          }
        }
        for (const component of combo.items) {
          if (!component.variantId) continue;
          const member = memberDocs.find((item) => String(item._id) === String(component.itemId));
          const variant = member?.variants.find(
            (v) => String(v._id) === String(component.variantId),
          );
          if (!variant || variant.is86)
            throw AppError.conflict(`Combo "${combo.name}" contains an unavailable variant`);
        }
      }

      resolved.push({
        build: {
          comboId: combo._id,
          comboComponents: combo.items.map((component) => ({
            itemId: component.itemId,
            variantId: component.variantId,
            qty: component.qty,
          })),
          name: combo.name,
          qty: inp.qty,
          basePrice: combo.price,
          modifiers: [],
          notes: inp.notes,
          status: 'pending',
        },
      });
    }
  }
  return resolved;
}

function pushTimeline(
  order: OrderDocument,
  status: string,
  ctx: ActorCtx | undefined,
  note?: string,
) {
  order.timeline.push({
    _id: new Types.ObjectId(),
    status: status as OrderStatus,
    at: new Date(),
    byUserId: ctx?.actorId ? new Types.ObjectId(ctx.actorId) : undefined,
    byName: ctx?.actorName ?? ctx?.actorEmail,
    note,
  });
}

interface PlaceOrderCommon {
  maxTotal?: number;
  items: ItemInput[];
  guestPhone?: string;
  guestName?: string;
  guestNotes?: string;
  customerId?: string;
  couponCode?: string;
}

export interface PlaceDineInInput extends PlaceOrderCommon {
  qrSlug?: string;
  tableId?: string;
}

export async function placeDineInOrder(
  input: PlaceDineInInput,
  ctx?: ActorCtx,
  attempt?: OrderRequest,
  guestAccess?: { token: unknown },
) {
  let tableId: Types.ObjectId | undefined;
  let qrCodeId: Types.ObjectId | undefined;
  if (input.qrSlug) {
    const qr = await QrCodeModel.findOne({ slug: input.qrSlug, isActive: true });
    if (!qr) throw AppError.badRequest('QR code not found');
    if (qr.type !== 'table') throw AppError.badRequest('QR is not a table QR');
    if (!qr.tableId) throw AppError.badRequest('QR is not bound to a table');
    tableId = qr.tableId;
    qrCodeId = qr._id;
  } else if (input.tableId) {
    tableId = new Types.ObjectId(input.tableId);
  } else {
    // Walk-in / direct web access — no table assigned, order still placed as dine_in
    const { qrSlug: _qs, tableId: _tid, ...common } = input;
    return finalizeOrder({ ...common, channel: 'dine_in' }, ctx, attempt);
  }

  const { tableId: primaryId, sessionId } = await resolveTableVisit(String(tableId), ctx ?? {}, guestAccess);
  tableId = primaryId;

  return finalizeOrder(
    {
      ...input,
      channel: 'dine_in',
      tableId,
      tableSessionId: sessionId,
      guestAccess,
      qrCodeId,
    },
    ctx,
    attempt,
  );
}

export interface PlaceWindowInput extends PlaceOrderCommon {
  qrSlug?: string;
  pickupAt?: Date;
}

export async function placeWindowOrder(
  input: PlaceWindowInput,
  guestPhone: string,
  ctx?: ActorCtx,
  attempt?: OrderRequest,
) {
  let qrCodeId: Types.ObjectId | undefined;
  if (input.qrSlug) {
    const qr = await QrCodeModel.findOne({ slug: input.qrSlug, isActive: true });
    if (!qr) throw AppError.badRequest('QR code not found');
    if (qr.type !== 'window') throw AppError.badRequest('QR is not a window QR');
    qrCodeId = qr._id;
  }
  const restaurant = await getOrCreateRestaurant();
  if (!restaurant.operatingModes.takeaway) {
    throw AppError.conflict('Takeaway is currently disabled');
  }
  if (restaurant.orderingPolicies?.requirePrepayOnWindow) {
    throw AppError.conflict('Online prepayment required for takeaway orders');
  }
  return finalizeOrder(
    {
      channel: 'window',
      guestPhone,
      qrCodeId,
      ...input,
    },
    ctx,
    attempt,
  );
}

export interface PlaceAssistedInput extends PlaceOrderCommon {
  tableId?: string;
}

export async function placeAssistedOrder(
  input: PlaceAssistedInput,
  ctx: ActorCtx,
  attempt?: OrderRequest,
) {
  let tableId: Types.ObjectId | undefined;
  let tableSessionId: Types.ObjectId | undefined;

  if (input.tableId) {
    const visit = await resolveTableVisit(input.tableId, ctx);
    tableId = visit.tableId;
    tableSessionId = visit.sessionId;
  }

  return finalizeOrder({ ...input, channel: 'assisted', tableId, tableSessionId }, ctx, attempt);
}

async function resolveTableVisit(id: string, ctx: ActorCtx, guestAccess?: { token: unknown }) {
  let table = await TableModel.findById(id);
  if (!table || !table.isActive) throw AppError.notFound('Active table not found');
  if (table.mergedIntoTableId) {
    table = await TableModel.findById(table.mergedIntoTableId);
    if (!table || !table.isActive) throw AppError.notFound('Primary table not found');
  }
  let visit = table.currentSessionId
    ? await TableSessionModel.findOne({ _id: table.currentSessionId, status: 'open' })
    : null;
  if (!visit && pilotZone(table.zone) && process.env.QR_SERVICE_MODE === 'live')
    throw AppError.conflict('Ask the host to seat your party first');
  if (guestAccess && (visit?.qrService || guestAccess.token) && grantedVisit(guestAccess.token) !== String(visit?._id))
    throw AppError.forbidden('Join this table visit before ordering');
  if (!visit) {
    const { openSession } = await import('@modules/tables/tableSession.service');
    try {
      const opened = await openSession({ tableId: String(table._id), guestCount: 1 }, ctx);
      return { tableId: table._id, sessionId: opened._id };
    } catch (error) {
      // A concurrent checkout may have opened this same visit while we waited.
      // Reuse that committed visit; do not turn the duplicate into a durable rejection.
      if (!(error instanceof AppError) || error.status !== 409) throw error;
      const current = await TableModel.findOne({
        _id: table._id,
        isActive: true,
        mergedIntoTableId: null,
      });
      const opened = current?.currentSessionId
        ? await TableSessionModel.findOne({
            _id: current.currentSessionId,
            tableId: current._id,
            status: 'open',
          })
        : null;
      if (!opened) throw error;
      if (guestAccess && opened.qrService && grantedVisit(guestAccess.token) !== String(opened._id))
        throw AppError.forbidden('Join this table visit before ordering');
      return { tableId: table._id, sessionId: opened._id };
    }
  }
  return { tableId: table._id, sessionId: visit._id };
}

interface FinalizeArgs extends PlaceOrderCommon {
  guestAccess?:{token:unknown};
  channel: 'dine_in' | 'window' | 'assisted';
  tableId?: Types.ObjectId;
  tableSessionId?: Types.ObjectId;
  qrCodeId?: Types.ObjectId;
  pickupAt?: Date;
}

export async function quoteGuestItems(inputs: ItemInput[]) {
  const resolved = await resolveItems(inputs);
  const restaurant = await getOrCreateRestaurant();
  if (!restaurant.tax.taxes.length)
    throw AppError.conflict(
      'Restaurant tax configuration must be completed before orders can be placed',
    );
  const items = resolved.map((r) => ({ _id: new Types.ObjectId(), lineTotal: 0, ...r.build }));
  return {
    currency: restaurant.currency,
    taxInclusive: restaurant.tax.taxInclusive,
    totals: computeTotals({ items, restaurant }),
  };
}

async function finalizeOrder(
  args: FinalizeArgs,
  ctx?: ActorCtx,
  attempt?: OrderRequest,
): Promise<OrderDocument> {
  const resolved = await resolveItems(args.items);
  const restaurant = await getOrCreateRestaurant();
  if (!restaurant.tax.taxes.length)
    throw AppError.conflict(
      'Restaurant tax configuration must be completed before orders can be placed',
    );

  // Auto-create / attach Customer when a phone is provided. Failure must not
  // block order placement, so we swallow errors here.
  let customerIdToUse: Types.ObjectId | undefined = args.customerId
    ? new Types.ObjectId(args.customerId)
    : undefined;
  if (!customerIdToUse && args.guestPhone) {
    try {
      const { ensureCustomerByPhone } = await import('@modules/customers/customer.service');
      const customer = await ensureCustomerByPhone(args.guestPhone, args.guestName);
      if (customer) customerIdToUse = customer._id;
    } catch {
      /* ignore — customer linkage is optional */
    }
  }

  const order = new OrderModel({
    orderNumber: await nextOrderNumber(),
    currency: restaurant.currency,
    channel: args.channel,
    status: 'placed',
    tableId: args.tableId,
    tableSessionId: args.tableSessionId,
    qrCodeId: args.qrCodeId,
    waiterId: ctx?.actorId ? new Types.ObjectId(ctx.actorId) : undefined,
    customerId: customerIdToUse,
    guestPhone: args.guestPhone,
    guestName: args.guestName,
    guestNotes: args.guestNotes,
    couponCode: args.couponCode,
    pickupAt: args.pickupAt,
  });

  for (const r of resolved) {
    order.items.push({ _id: new Types.ObjectId(), lineTotal: 0, ...r.build });
  }

  // Price without a discount first so we have a real subtotal/breakdown to
  // validate the coupon against, then re-price with the actual discount.
  order.totals = computeTotals({ items: order.items, restaurant });

  let appliedCoupon: { couponId: string; amount: number } | undefined;
  if (args.couponCode) {
    const itemsBreakdown = resolved.map((r, i) => ({
      itemId: r.itemId,
      categoryId: r.categoryId,
      lineTotal: order.items[i].lineTotal,
    }));
    const result = await validateCoupon({
      code: args.couponCode,
      customerPhone: args.guestPhone,
      customerId: customerIdToUse ? String(customerIdToUse) : undefined,
      context: {
        subtotal: round2(order.totals.subtotal + order.totals.modifierTotal),
        itemsBreakdown,
        channel: args.channel,
      },
    });
    if (!result.valid) {
      throw AppError.badRequest(result.reason ?? 'Invalid coupon code');
    }
    order.totals = computeTotals({ items: order.items, restaurant, discount: result.amount });
    appliedCoupon = { couponId: result.couponId!, amount: result.amount };
  }

  order.estimatedPrepMinutes = estimatePrepMinutes(order.items);

  // Apply eligible bundles/promotions
  try {
    const { getActiveBundles, checkBundleEligibility, calculateBundleDiscount } =
      await import('@modules/promotions/bundle.service');
    const activeBundles = await getActiveBundles();
    const customerTags: import('@modules/promotions/bundle.model').CustomerTag[] = customerIdToUse
      ? []
      : ['first_time']; // Do not invent a regular-customer classification.

    for (const bundle of activeBundles) {
      const eligible = await checkBundleEligibility(
        String(bundle._id),
        customerTags,
        order.totals.subtotal,
      );
      if (eligible.eligible) {
        const discount = await calculateBundleDiscount(
          String(bundle._id),
          order.items,
          order.totals.subtotal,
        );
        if (discount > 0) {
          order.appliedBundles = order.appliedBundles || [];
          order.appliedBundles.push({ bundleId: String(bundle._id), discount });
          order.totals = computeTotals({
            items: order.items,
            restaurant,
            discount: (order.totals.discount || 0) + discount,
          });
        }
      }
    }
  } catch {
    // Bundle logic is optional, don't fail order placement
  }

  if (
    args.maxTotal !== undefined &&
    Math.round(order.totals.grand * 100) > Math.round(args.maxTotal * 100)
  )
    throw AppError.conflict('The total changed. Refresh your cart and review the current price.');
  if (args.channel === 'window') order.windowToken = await nextWindowToken();
  pushTimeline(order, 'placed', ctx);
  await mongoose.connection.transaction(async (session) => {
    await completeOrderRequest(attempt, order._id, session);
    if (args.tableId && args.tableSessionId) {
      const table = await TableModel.findOneAndUpdate(
        { _id: args.tableId, currentSessionId: args.tableSessionId, isActive: true },
        { $set: { status: 'ordered' }, $inc: { scheduleVersion: 1 } },
        { new: true, session },
      );
      if (!table) throw AppError.conflict('Table visit changed; refresh before placing the order');
      const visit = await TableSessionModel.findOneAndUpdate(
        { _id: args.tableSessionId, status: 'open' },
        { $addToSet: { orderIds: order._id }, $inc: { runningTotal: order.totals.grand } },
        { new: true, session },
      );
      if (!visit) throw AppError.conflict('Table visit is closed');
      if (visit.qrService) {
        if (args.guestAccess && grantedVisit(args.guestAccess.token)!==String(visit._id))
          throw AppError.forbidden("Rejoin this table before placing an order");
        order.qrService = true;
        order.waiterId = visit.waiterId;
      }
    }
    await order.save({ session });
    if (appliedCoupon)
      await recordCouponRedemption(
        appliedCoupon.couponId,
        order._id,
        appliedCoupon.amount,
        customerIdToUse,
        args.guestPhone,
        session,
      );
    if (args.qrCodeId)
      await QrCodeModel.updateOne(
        { _id: args.qrCodeId },
        { $inc: { 'analytics.orders': 1, 'analytics.revenue': order.totals.grand } },
        { session },
      );
    await AuditLogModel.create(
      [
        {
          ...ctx,
          action: 'order.placed',
          entity: 'Order',
          entityId: String(order._id),
          metadata: {
            channel: args.channel,
            total: order.totals.grand,
            orderNumber: order.orderNumber,
          },
        },
      ],
      { session },
    );
  });

  emitToStaff('order:new', toListDTO(order));
  emitToKdsAll('order:new', toKdsDTO(order));
  if (args.channel === 'window')
    emitToNowServing({ windowToken: order.windowToken, status: 'placed' });

  if (order.guestPhone) {
    void import('@modules/notifications/notification.service').then(({ dispatchSafe }) =>
      dispatchSafe({
        eventKey: 'order.placed.guest',
        to: order.guestPhone!,
        payload: {
          restaurantName: restaurant.brand.name,
          orderNumber: order.orderNumber,
          channel: order.channel,
          windowToken: order.windowToken ?? '',
          grand: order.totals.grand,
          estimatedPrepMinutes: order.estimatedPrepMinutes,
        },
        relatedOrderId: order._id,
      }),
    );
  }

  return order;
}

export async function addItemsToOrder(
  orderId: string,
  items: ItemInput[],
  ctx: ActorCtx,
  maxTotal?: number,
  attempt?: OrderRequest,
) {
  const order = await mongoose.connection.transaction(async (session) => {
    await completeOrderRequest(attempt, new Types.ObjectId(orderId), session);
    const order = await OrderModel.findById(orderId).session(session);
    if (!order) throw AppError.notFound('Order not found');
    if (order.couponCode || order.appliedBundles?.length)
      throw AppError.conflict(
        'Promotional orders require manager review before changing items; place additions as a separate order',
      );
    if (['settled', 'cancelled'].includes(order.status)) {
      throw AppError.conflict(`Cannot add items — order is ${order.status}`);
    }
    const { InvoiceModel } = await import('@modules/invoices/invoice.model');
    if (await InvoiceModel.exists({ orderId: order._id, status: 'final' }).session(session))
      throw AppError.conflict(
        'This order is already billed. Place additional items as a new order.',
      );
    const previousGrand = order.totals.grand;
    const resolved = await resolveItems(items);
    for (const r of resolved) {
      order.items.push({ _id: new Types.ObjectId(), lineTotal: 0, ...r.build });
    }
    const restaurant = await getOrCreateRestaurant();
    order.totals = computeTotals({
      items: order.items,
      restaurant,
      discount: order.totals.discount,
    });
    const difference = round2(order.totals.grand - previousGrand);
    if (maxTotal !== undefined && Math.round(difference * 100) > Math.round(maxTotal * 100))
      throw AppError.conflict('The total changed. Refresh your cart and review the current price.');
    order.estimatedPrepMinutes = estimatePrepMinutes(order.items);
    pushTimeline(order, 'item_added', ctx, `${resolved.length} item(s) added`);
    await order.save({ session });
    if (order.tableSessionId) {
      await TableSessionModel.updateOne(
        { _id: order.tableSessionId },
        { $inc: { runningTotal: difference } },
        { session },
      );
    }
    await AuditLogModel.create(
      [
        {
          ...ctx,
          action: 'order.items.add',
          entity: 'Order',
          entityId: String(order._id),
          metadata: { addedCount: resolved.length },
        },
      ],
      { session },
    );
    return order;
  });
  emitToStaff('order:updated', toListDTO(order));
  emitToKdsAll('order:updated', toKdsDTO(order));
  emitToGuestOrder(String(order._id), 'order:updated', toGuestDTO(order));

  return order;
}

export interface ListOrdersOpts {
  q?: string;
  status?: OrderStatus;
  channel?: 'dine_in' | 'window' | 'assisted';
  tableId?: string;
  waiterId?: string;
  from?: Date;
  to?: Date;
  page?: number;
  limit?: number;
}

export async function listOrders(opts: ListOrdersOpts) {
  const page = Math.max(1, opts.page ?? 1);
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  const filter: Record<string, unknown> = {};
  if (opts.q?.trim()) {
    const pattern = opts.q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = ['orderNumber', 'guestName', 'guestPhone', 'windowToken'].map((field) => ({
      [field]: { $regex: pattern, $options: 'i' },
    }));
  }
  if (opts.status) filter.status = opts.status;
  if (opts.channel) filter.channel = opts.channel;
  if (opts.tableId) filter.tableId = new Types.ObjectId(opts.tableId);
  if (opts.waiterId) filter.waiterId = new Types.ObjectId(opts.waiterId);
  if (opts.from || opts.to) {
    filter.createdAt = {
      ...(opts.from ? { $gte: opts.from } : {}),
      ...(opts.to ? { $lte: opts.to } : {}),
    };
  }
  const [items, total] = await Promise.all([
    OrderModel.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    OrderModel.countDocuments(filter),
  ]);
  return { items, meta: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 } };
}

export async function getOrder(id: string) {
  const o = await OrderModel.findById(id);
  if (!o) throw AppError.notFound('Order not found');
  return o;
}

export async function getOrderByNumber(orderNumber: string) {
  return OrderModel.findOne({ orderNumber });
}

export async function acceptOrder(id: string, ctx: ActorCtx) {
  const order = await mongoose.connection.transaction(async (session) => {
    const order = await OrderModel.findById(id).session(session);
    if (!order) throw AppError.notFound('Order not found');
    if (order.status !== 'placed') throw AppError.conflict(`Cannot accept from "${order.status}"`);
    order.status = 'accepted';
    order.acceptedById = ctx.actorId ? new Types.ObjectId(ctx.actorId) : undefined;
    for (const it of order.items) {
      if (it.status === 'pending') {
        it.status = 'accepted';
        it.acceptedAt = new Date();
      }
    }
    pushTimeline(order, 'accepted', ctx);
    await order.save({ session });
    await AuditLogModel.create(
      [
        {
          ...ctx,
          action: 'order.accepted',
          entity: 'Order',
          entityId: String(order._id),
        },
      ],
      { session },
    );
    return order;
  });
  emitToStaff('order:status_changed', { id: String(order._id), status: 'accepted' });
  emitToKdsAll('order:updated', toKdsDTO(order));
  emitToGuestOrder(String(order._id), 'order:status_changed', { status: 'accepted' });

  return order;
}

export async function voidItem(orderId: string, itemId: string, reason: string, ctx: ActorCtx) {
  const order = await mongoose.connection.transaction(async (session) => {
    const order = await OrderModel.findById(orderId).session(session);
    if (!order) throw AppError.notFound('Order not found');
    if (order.couponCode || order.appliedBundles?.length)
      throw AppError.conflict(
        'Promotional orders require manager review before changing items; place additions as a separate order',
      );
    const { InvoiceModel } = await import('@modules/invoices/invoice.model');
    if (await InvoiceModel.exists({ orderId: order._id, status: 'final' }).session(session))
      throw AppError.conflict('Refund and void the invoice before cancelling billed items.');
    if (['settled', 'cancelled'].includes(order.status)) {
      throw AppError.conflict(`Cannot void — order is ${order.status}`);
    }
    const item = order.items.find((i) => String(i._id) === itemId);
    if (!item) throw AppError.notFound('Order item not found');
    if (item.status === 'cancelled') throw AppError.badRequest('Item already voided');
    const priorGrand = order.totals.grand;
    item.status = 'cancelled';
    item.voidReason = reason;
    item.voidedById = ctx.actorId ? new Types.ObjectId(ctx.actorId) : undefined;
    const restaurant = await getOrCreateRestaurant();
    order.totals = computeTotals({ items: order.items, restaurant });
    pushTimeline(order, 'item_voided', ctx, reason);
    await order.save({ session });
    if (order.tableSessionId) {
      await TableSessionModel.updateOne(
        { _id: order.tableSessionId },
        { $inc: { runningTotal: round2(order.totals.grand - priorGrand) } },
        { session },
      );
    }
    await AuditLogModel.create(
      [
        {
          ...ctx,
          action: 'order.item.void',
          entity: 'Order',
          entityId: String(order._id),
          metadata: { itemId, reason },
        },
      ],
      { session },
    );
    return order;
  });
  emitToStaff('order:updated', toListDTO(order));
  emitToKdsAll('order:updated', toKdsDTO(order));

  return order;
}

export async function cancelOrder(id: string, reason: string, ctx: ActorCtx) {
  const order = await mongoose.connection.transaction(async (session) => {
    const order = await OrderModel.findById(id).session(session);
    if (!order) throw AppError.notFound('Order not found');
    if (order.deliveryId)
      throw AppError.conflict(
        'Use the delivery board to resolve this order before changing fulfillment',
      );
    const { InvoiceModel } = await import('@modules/invoices/invoice.model');
    if (await InvoiceModel.exists({ orderId: order._id, status: 'final' }).session(session))
      throw AppError.conflict('Refund and void the invoice before cancelling billed items.');
    if (['settled', 'cancelled'].includes(order.status)) {
      throw AppError.conflict(`Cannot cancel from "${order.status}"`);
    }
    order.status = 'cancelled';
    for (const it of order.items) if (it.status !== 'cancelled') it.status = 'cancelled';
    pushTimeline(order, 'cancelled', ctx, reason);
    await order.save({ session });
    if (order.tableSessionId) {
      await TableSessionModel.updateOne(
        { _id: order.tableSessionId },
        { $inc: { runningTotal: -order.totals.grand } },
        { session },
      );
    }
    await AuditLogModel.create(
      [
        {
          ...ctx,
          action: 'order.cancelled',
          entity: 'Order',
          entityId: String(order._id),
          metadata: { reason },
        },
      ],
      { session },
    );
    return order;
  });
  emitToStaff('order:status_changed', { id: String(order._id), status: 'cancelled' });
  emitToKdsAll('order:cancelled', { id: String(order._id) });
  emitToGuestOrder(String(order._id), 'order:status_changed', { status: 'cancelled' });

  return order;
}

export async function markServed(id: string, ctx: ActorCtx) {
  const order = await mongoose.connection.transaction(async (session) => {
    const order = await OrderModel.findById(id).session(session);
    if (!order) throw AppError.notFound('Order not found');
    if (order.deliveryId)
      throw AppError.conflict(
        'Use the delivery board to resolve this order before changing fulfillment',
      );
    if (order.status !== 'ready') throw AppError.conflict(`Cannot serve from "${order.status}"`);
    if (order.qrService && order.items.some(it=>it.status==='ready' && !it.runnerId))
      throw AppError.conflict('Record pickup at the service pass first');
    order.status = 'served';
    for (const it of order.items) {
      if (it.status === 'ready') {
        it.status = 'served';
        it.servedAt = new Date();
      }
    }
    pushTimeline(order, 'served', ctx);
    await order.save({ session });
    await AuditLogModel.create(
      [
        {
          ...ctx,
          action: 'order.served',
          entity: 'Order',
          entityId: String(order._id),
        },
      ],
      { session },
    );
    return order;
  });
  emitToStaff('order:status_changed', { id: String(order._id), status: 'served' });
  emitToGuestOrder(String(order._id), 'order:status_changed', { status: 'served' });

  if (order.paymentStatus === 'paid') {
    const { maybeSettleOrder } = await import('@modules/payments/payment.service');
    await maybeSettleOrder(order._id, ctx);
    return OrderModel.findById(order._id);
  }
  return order;
}

export async function markPickedUp(windowToken: string, ctx: ActorCtx) {
  const order = await mongoose.connection.transaction(async (session) => {
    const order = await OrderModel.findOne({ windowToken, channel: 'window' }).session(session);
    if (!order) throw AppError.notFound('Order not found for that token');
    if (order.deliveryId)
      throw AppError.conflict(
        'Use the delivery board to resolve this order before changing fulfillment',
      );
    if (order.status !== 'ready') throw AppError.conflict(`Cannot pick up from "${order.status}"`);
    order.status = 'served';
    order.pickedUpAt = new Date();
    pushTimeline(order, 'served', ctx, 'Picked up');
    await order.save({ session });
    await AuditLogModel.create(
      [
        {
          ...ctx,
          action: 'order.picked_up',
          entity: 'Order',
          entityId: String(order._id),
          metadata: { windowToken },
        },
      ],
      { session },
    );
    return order;
  });
  emitToStaff('order:status_changed', { id: String(order._id), status: 'served' });
  emitToNowServing({ windowToken: order.windowToken, status: 'picked_up' });
  emitToGuestOrder(String(order._id), 'order:status_changed', { status: 'served' });

  if (order.paymentStatus === 'paid') {
    const { maybeSettleOrder } = await import('@modules/payments/payment.service');
    await maybeSettleOrder(order._id, ctx);
    return OrderModel.findById(order._id);
  }
  return order;
}

export async function addGuestRequest(
  orderId: string,
  type: 'call_waiter' | 'water' | 'bill' | 'other',
  message?: string,
) {
  const order = await OrderModel.findById(orderId);
  if (!order) throw AppError.notFound('Order not found');
  const req = {
    _id: new Types.ObjectId(),
    type,
    message,
    at: new Date(),
    resolved: false,
  };
  order.guestRequests.push(req);
  await order.save();
  emitToStaff('order:guest_request', {
    orderId: String(order._id),
    request: req,
    table: order.tableId,
  });
  return req;
}

export async function resolveGuestRequest(orderId: string, requestId: string, ctx: ActorCtx) {
  const order = await OrderModel.findById(orderId);
  if (!order) throw AppError.notFound('Order not found');
  const req = order.guestRequests.find((r) => String(r._id) === requestId);
  if (!req) throw AppError.notFound('Request not found');
  req.resolved = true;
  req.resolvedAt = new Date();
  req.resolvedById = ctx.actorId ? new Types.ObjectId(ctx.actorId) : undefined;
  await order.save();
  emitToStaff('order:guest_request', { orderId: String(order._id), request: req, resolved: true });
  return req;
}

// Called by KDS when item statuses change — recalculates overall order status
export async function recomputeOrderStatus(orderId: string) {
  const transition = await mongoose.connection.transaction(async (session) => {
    const order = await OrderModel.findById(orderId).session(session);
    if (!order || ['settled', 'cancelled'].includes(order.status)) return;
    const active = order.items.filter((i) => i.status !== 'cancelled');
    if (!active.length) return;
    const allReady = active.every((i) => i.status === 'ready' || i.status === 'served');
    const anyPreparing = active.some((i) => i.status === 'preparing');
    const anyAccepted = active.some((i) => i.status === 'accepted' || i.status === 'pending');

    let next: OrderStatus | null = null;
    if (
      active.every((item) => item.status === 'served') &&
      !['settled', 'cancelled'].includes(order.status)
    )
      next = 'served';
    else if (allReady && order.status !== 'served' && order.status !== 'settled') next = 'ready';
    else if (anyPreparing && (order.status === 'placed' || order.status === 'accepted'))
      next = 'preparing';
    else if (anyAccepted && order.status === 'placed') next = 'accepted';

    if (next && next !== order.status) {
      order.status = next;
      pushTimeline(order, next, { actorName: 'system' });
      await order.save({ session });
      return { order, next };
    }
    return null;
  });
  if (transition) {
    const { order, next } = transition;
    if (next === 'served' && order.paymentStatus === 'paid') {
      const { maybeSettleOrder } = await import('@modules/payments/payment.service');
      await maybeSettleOrder(order._id, {});
    }
    emitToStaff('order:status_changed', { id: String(order._id), status: next });
    emitToGuestOrder(String(order._id), 'order:status_changed', { status: next });
    if (next === 'ready' && order.channel === 'window' && !order.deliveryId) {
      emitToNowServing({ windowToken: order.windowToken, status: 'ready' });
      if (order.guestPhone) {
        const restaurant = await getOrCreateRestaurant();
        void import('@modules/notifications/notification.service').then(({ dispatchSafe }) =>
          dispatchSafe({
            eventKey: 'order.ready.window',
            to: order.guestPhone!,
            payload: {
              restaurantName: restaurant.brand.name,
              windowToken: order.windowToken,
              orderNumber: order.orderNumber,
            },
            relatedOrderId: order._id,
          }),
        );
      }
    }
  }
}

export async function updateItemStatus(
  orderId: string,
  itemId: string,
  next: OrderItemStatus,
  station: string | undefined,
  ctx: ActorCtx,
) {
  const order = await mongoose.connection.transaction(async (session) => {
    const order = await OrderModel.findById(orderId).session(session);
    if (!order) throw AppError.notFound('Order not found');
    if (next === 'cancelled')
      throw AppError.forbidden('Use the authorized item-void workflow to cancel an item');
    if (next === 'served' && order.deliveryId)
      throw AppError.conflict('Confirm handoff in the delivery board');
    if (['cancelled', 'settled', 'served'].includes(order.status))
      throw AppError.conflict('This order is no longer in preparation');
    const item = order.items.find((i) => String(i._id) === itemId);
    if (!item) throw AppError.notFound('Order item not found');
    if (next === 'served' && order.qrService && !item.runnerId)
      throw AppError.conflict('Record pickup at the service pass first');
    if (station && item.station !== station)
      throw AppError.forbidden(`Item not at station "${station}"`);
    if (item.status === 'cancelled') throw AppError.badRequest('Item is cancelled');

    const order_ok: Record<OrderItemStatus, OrderItemStatus[]> = {
      pending: ['accepted', 'preparing', 'cancelled'],
      accepted: ['preparing', 'ready', 'cancelled'],
      preparing: ['ready', 'cancelled'],
      ready: ['served'],
      served: [],
      cancelled: [],
    };
    if (!order_ok[item.status].includes(next)) {
      throw AppError.badRequest(`Cannot transition item from "${item.status}" to "${next}"`);
    }
    item.status = next;
    const now = new Date();
    if (next === 'accepted') item.acceptedAt = now;
    if (next === 'preparing') item.preparingAt = now;
    if (next === 'ready') item.readyAt = now;
    if (next === 'served') item.servedAt = now;
    await order.save({ session });
    await AuditLogModel.create(
      [
        {
          ...ctx,
          action: 'order.item.status',
          entity: 'Order',
          entityId: String(order._id),
          metadata: { itemId, status: next, station: item.station },
        },
      ],
      { session },
    );
    return order;
  });
  await recomputeOrderStatus(orderId);

  // Send push notification when item becomes ready or order becomes ready
  if (next === 'ready' || order.status === 'ready') {
    const { dispatchToUser } = await import('@modules/notifications/push.provider');
    if (order.channel === 'window' && !order.deliveryId) {
      const title = order.status === 'ready' ? 'Your order is ready!' : 'Order item ready';
      const body = `Order #${order.orderNumber} has ${next === 'ready' ? 'an item' : 'items'} ready for pickup`;
      dispatchToUser(String(order._id), {
        title,
        body,
        tag: `order-${order._id}`,
        data: { orderId: String(order._id), orderNumber: order.orderNumber },
      }).catch(() => {
        // Silently fail if push disabled
      });
    }
  }

  emitToKdsAll('order:item_status_changed', {
    orderId: String(order._id),
    itemId,
    status: next,
    station: order.items.find((i) => String(i._id) === itemId)?.station,
  });
  emitToStaff('order:item_status_changed', {
    orderId: String(order._id),
    itemId,
    status: next,
  });

  return order;
}

// === DTO helpers for sockets ===

export function toListDTO(o: OrderDocument) {
  return {
    id: String(o._id),
    orderNumber: o.orderNumber,
    channel: o.channel,
    fulfillment: o.deliveryId ? 'delivery' : o.tableId ? 'dine_in' : 'pickup',
    status: o.status,
    tableId: o.tableId ? String(o.tableId) : undefined,
    windowToken: o.windowToken,
    itemCount: o.items.filter((i) => i.status !== 'cancelled').length,
    grand: o.totals.grand,
    createdAt: o.createdAt,
  };
}

export function toKdsDTO(o: OrderDocument) {
  return {
    id: String(o._id),
    orderNumber: o.orderNumber,
    channel: o.channel,
    fulfillment: o.deliveryId ? 'delivery' : o.tableId ? 'dine_in' : 'pickup',
    tableId: o.tableId ? String(o.tableId) : undefined,
    windowToken: o.windowToken,
    items: o.items
      .filter((i) => i.status !== 'cancelled' && i.status !== 'served')
      .map((i) => ({
        id: String(i._id),
        name: i.name,
        variantName: i.variantName,
        qty: i.qty,
        notes: i.notes,
        station: i.station,
        status: i.status,
        modifiers: i.modifiers.map((m) => m.modifierName),
      })),
    createdAt: o.createdAt,
  };
}

export function toGuestDTO(o: OrderDocument) {
  return {
    currency: o.currency ?? 'INR',
    qrService:o.qrService,
    pickupAt: o.pickupAt,
    paymentStatus: o.paymentStatus,
    guestRequests: o.guestRequests.map((r) => ({
      id: String(r._id),
      type: r.type,
      resolved: r.resolved,
    })),
    id: String(o._id),
    orderNumber: o.orderNumber,
    channel: o.channel,
    fulfillment: o.deliveryId ? 'delivery' : o.tableId ? 'dine_in' : 'pickup',
    status: o.status,
    windowToken: o.windowToken,
    estimatedPrepMinutes: o.estimatedPrepMinutes,
    totals: o.totals,
    items: o.items.map((i) => ({
      id: String(i._id),
      name: i.name,
      variantName: i.variantName,
      qty: i.qty,
      lineTotal: i.lineTotal,
      status: i.status,
      modifiers: i.modifiers.map((m) => m.modifierName),
    })),
  };
}

