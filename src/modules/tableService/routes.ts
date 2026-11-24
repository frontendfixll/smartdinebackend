import { recordNotice } from './notices';
import { Router } from 'express';
import { ServiceTask } from './task.model';
import mongoose, { Types } from 'mongoose';
import { z } from 'zod';
import { asyncHandler } from '@utils/asyncHandler';
import { ok } from '@utils/apiResponse';
import { AppError } from '@utils/AppError';
import { requireAuth } from '@middleware/requireAuth';
import { requirePermission } from '@middleware/requirePermission';
import { guestWriteLimiter, otpVerifyLimiter, publicReadLimiter } from '@middleware/rateLimits';
import { TableModel } from '@modules/tables/table.model';
import { TableSessionModel } from '@modules/tables/tableSession.model';
import { entry } from './entry';
import { OrderModel } from '@modules/orders/order.model';
import { updateItemStatus } from '@modules/orders/order.service';
import { requireAnyPermission } from '@middleware/requirePermission';
import { UserModel } from '@modules/users/user.model';
import { RoleModel } from '@modules/roles/role.model';
import { ShiftModel } from '@modules/shifts/shift.model';
import { seatingOwner } from './assignment';
import { codeMatches, grantedVisit, grantVisit, joinCode } from './membership';

const router = Router();
const id = z.string().regex(/^[a-f\d]{24}$/i);
const slug = z.string().min(3).max(20);
const tasks = (visit: Types.ObjectId) =>
  ServiceTask.find({ visit })
    .select('type state createdAt updatedAt')
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();
router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
router.get(
  '/entry',
  publicReadLimiter,
  asyncHandler(async (req, res) => {
    const { table, visit, enrolled } = await entry(req.query.qr);
    return ok(res, { enrolled, table: table.number, seated: !!visit });
  }),
);
router.post(
  '/arrivals',
  guestWriteLimiter,
  asyncHandler(async (req, res) => {
    const { table, enrolled } = await entry(req.body.qr);
    const covers = z.number().int().min(1).max(table.capacity).parse(req.body.covers);
    if (!enrolled) throw AppError.conflict('Please check in with the host');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 10 * 60_000);
    const claim = await TableModel.findOneAndUpdate(
      {
        _id: table._id,
        isActive: true,
        mergedIntoTableId: null,
        status: 'vacant',
        currentSessionId: null,
        $or: [{ arrival: null }, { 'arrival.expiresAt': { $lte: now } }],
      },
      { $set: { arrival: { covers, expiresAt } } },
      { new: true },
    );
    if (claim) return ok(res, { expiresAt });
    const same = await TableModel.findOne({
      _id: table._id,
      status: 'vacant',
      currentSessionId: null,
      'arrival.covers': covers,
      'arrival.expiresAt': { $gt: now },
    }).lean();
    if (!same)
      throw AppError.conflict('This table needs host confirmation. Ask the floor team for help.');
    return ok(res, { expiresAt: same.arrival!.expiresAt });
  }),
);
router.post(
  '/join',
  otpVerifyLimiter,
  asyncHandler(async (req, res) => {
    const { table, visit, enrolled } = await entry(req.body.qr);
    const code = z.string().trim().toUpperCase().parse(req.body.code);
    if (!enrolled || !visit || !codeMatches(String(visit._id), code))
      throw AppError.forbidden('Check the table code with your waiter');
    return ok(res, {
      grant: grantVisit(String(visit._id)),
      visitId: String(visit._id),
      table: table.number,
    });
  }),
);
router.get(
  '/current',
  publicReadLimiter,
  asyncHandler(async (req, res) => {
    const visitId = grantedVisit(req.headers['x-visit-token']);
    const { visit } = await entry(req.query.qr);
    if (!visit?.qrService || String(visit._id) !== visitId)
      throw AppError.forbidden('This table visit has ended or moved');
    return ok(res, { waiter: visit.waiterName?.split(' ')[0], tasks: await tasks(visit._id) });
  }),
);
router.post(
  '/requests',
  guestWriteLimiter,
  asyncHandler(async (req, res) => {
    const visitId = grantedVisit(req.headers['x-visit-token']);
    const { qr, type, key } = z
      .object({ qr: slug, type: z.enum(['water', 'help', 'bill']), key: z.string().uuid() })
      .parse(req.body);
    const { visit } = await entry(qr);
    if (String(visit?._id) !== visitId) throw AppError.forbidden('Rejoin the table visit');
    const task = await mongoose.connection.transaction(async (session) => {
      const active = await TableSessionModel.findOneAndUpdate(
        { _id: visitId, status: 'open', qrService: true, tableId: visit!.tableId },
        { $inc: { serviceVersion: 1 } },
        { session },
      );
      if (!active) throw AppError.conflict('This visit has ended or moved');
      const previous = await ServiceTask.findOne({ visit: active._id, requestKeys: key }).session(
        session,
      );
      if (previous && previous.type !== type) throw AppError.conflict('Request key already used');
      if (previous) return previous;
      const pending = await ServiceTask.findOne({
        visit: active._id,
        type,
        state: { $ne: 'completed' },
      }).session(session);
      if (pending) {
        pending.requestKeys.push(key);
        return pending.save({ session });
      }
      await recordNotice(session, active._id, type, active.waiterId);
      return (
        await ServiceTask.create([{ visit: active._id, type, requestKeys: [key] }], { session })
      )[0];
    });
    return ok(res, { id: task._id, state: task.state });
  }),
);
router.use(requireAuth);
router.get(
  '/pass',
  requireAnyPermission('kds:read', 'table:read'),
  asyncHandler(async (_req, res) => {
    const orders = await OrderModel.find({
      qrService: true,
      status: { $in: ['placed', 'accepted', 'preparing', 'ready'] },
      'items.status': 'ready',
    })
      .select(
        'tableId orderNumber items._id items.status items.qty items.name items.runnerId items.readyAt',
      )
      .populate('tableId', 'number')
      .lean();
    return ok(
      res,
      orders.flatMap((o) =>
        o.items
          .filter((i) => i.status === 'ready')
          .map((i) => ({
            orderId: o._id,
            itemId: i._id,
            table: (o.tableId as unknown as { number: string })?.number,
            orderNumber: o.orderNumber,
            name: i.name,
            qty: i.qty,
            runnerId: i.runnerId,
            readyAt: i.readyAt,
          })),
      ),
    );
  }),
);
router.post(
  '/pass/:order/:item',
  requireAnyPermission('kds:update', 'table:update'),
  asyncHandler(async (req, res) => {
    const orderId = id.parse(req.params.order),
      itemId = id.parse(req.params.item);
    const action = z.enum(['pickup', 'serve']).parse(req.body.action);
    const actor = new Types.ObjectId(req.user!.id);
    const order = await OrderModel.findOne({ _id: orderId, qrService: true })
      .select('items')
      .lean();
    const line = order?.items.find((i) => String(i._id) === itemId);
    if (!line) throw AppError.notFound('Runner item not found');
    if (line.runnerId && !line.runnerId.equals(actor))
      throw AppError.conflict('Another runner has this item');
    if (line.runnerId && (action === 'pickup' || line.status === 'served'))
      return ok(res, { state: line.status });
    if (action === 'pickup') {
      const result = await OrderModel.updateOne(
        {
          _id: orderId,
          qrService: true,
          status: { $in: ['placed', 'accepted', 'preparing', 'ready'] },
          items: { $elemMatch: { _id: itemId, status: 'ready', runnerId: null } },
        },
        { $set: { 'items.$.runnerId': actor, 'items.$.pickedUpAt': new Date() } },
      );
      if (!result.modifiedCount)
        throw AppError.conflict('Pickup changed. Refresh the service pass.');
    } else {
      if (!line.runnerId) throw AppError.conflict('Confirm pickup first');
      await updateItemStatus(orderId, itemId, 'served', undefined, {
        actorId: req.user!.id,
        actorName: req.user!.name,
      });
    }
    return ok(res, { state: action });
  }),
);
router.use(requirePermission('table:read'));
router.get(
  '/inbox',
  asyncHandler(async (_req, res) => {
    const visits = await TableSessionModel.find({ qrService: true, status: 'open' })
      .select(
        'tableId waiterId waiterName openedAt assignedAt greetedAt guestCount offerName offerExpiresAt',
      )
      .lean();
    const pending = await ServiceTask.find({
      visit: { $in: visits.map((v) => v._id) },
      state: { $ne: 'completed' },
    })
      .select('visit type state createdAt')
      .sort({ createdAt: 1 })
      .lean();
    const arrivals = await TableModel.find({
      isActive: true,
      status: 'vacant',
      currentSessionId: null,
      'arrival.expiresAt': { $gt: new Date() },
    })
      .select('number arrival')
      .lean();
    const available = await ShiftModel.find({
      status: 'open',
      breaks: { $not: { $elemMatch: { endedAt: null } } },
    }).distinct('userId');
    const onFloor = new Set(available.map(String));
    return ok(res, {
      visits: visits.map((v) => ({
        ...v,
        needsCover: !v.waiterId || !onFloor.has(String(v.waiterId)),
      })),
      tasks: pending,
      arrivals,
    });
  }),
);
router.get(
  '/visits/:id',
  asyncHandler(async (req, res) => {
    const visit = await TableSessionModel.findOne({
      _id: id.parse(req.params.id),
      qrService: true,
      status: 'open',
    }).lean();
    if (!visit) throw AppError.notFound('Open QR visit not found');
    return ok(res, { code: joinCode(String(visit._id)), tasks: await tasks(visit._id) });
  }),
);
router.use(requirePermission('table:update'));
router.post(
  '/visits/:id/greet',
  asyncHandler(async (req, res) => {
    const visit = await TableSessionModel.findOneAndUpdate(
      { _id: id.parse(req.params.id), status: 'open', qrService: true, waiterId: req.user!.id },
      [{ $set: { greetedAt: { $ifNull: ['$greetedAt', '$$NOW'] } } }],
      { new: true },
    );
    if (!visit) throw AppError.conflict('Only the current waiter can confirm greeting');
    return ok(res, { greetedAt: visit.greetedAt });
  }),
);
router.post(
  '/visits/:id/assign',
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        previous: id.nullable(),
        version: z.number().int().min(0),
        waiterId: id.optional(),
        overrideReason: z.string().trim().min(4).max(200).optional(),
      })
      .parse(req.body);
    const visit = await mongoose.connection.transaction(async (session) => {
      const v = await TableSessionModel.findOne({
        _id: id.parse(req.params.id),
        status: 'open',
        qrService: true,
        waiterId: input.previous,
        assignmentVersion: input.version,
      }).session(session);
      if (!v) throw AppError.conflict('Table ownership changed. Refresh the floor.');
      const table = await TableModel.findById(v.tableId).session(session);
      if (!table) throw AppError.notFound('Table not found');
      if (input.previous && !input.waiterId) throw AppError.badRequest('Choose a new waiter');
      if (input.waiterId && input.waiterId === input.previous)
        throw AppError.badRequest('Choose a different waiter');
      const manager = req.user!.role.permissions.some((p) => p === '*' || p === 'user:update');
      if (input.overrideReason && !manager)
        throw AppError.forbidden('Manager permission required for an override');
      const owner = await seatingOwner(
        table.zone,
        v.guestCount,
        session,
        input.waiterId,
        true,
        v._id,
      );
      if (!owner.waiterId) throw AppError.conflict('No waiter available within capacity');
      const accepting =
        String(v.offerTo) === req.user!.id &&
        req.user!.id === input.waiterId &&
        (v.offerExpiresAt?.getTime() ?? 0) > Date.now();
      if (input.previous && !accepting && !input.overrideReason) {
        if (req.user!.id !== input.previous && !manager)
          throw AppError.forbidden('Only the current waiter or a manager can offer a handover');
        v.set({
          offerTo: owner.waiterId,
          offerName: owner.waiterName,
          offerExpiresAt: new Date(Date.now() + 120000),
          assignmentVersion: input.version + 1,
        });
        await v.save({ session });
        await recordNotice(
          session,
          v._id,
          'handover_offered',
          v.offerTo,
          req.user!.id,
          input.previous,
        );
        return { offeredTo: v.offerName };
      }
      v.set({
        offerTo: undefined,
        offerExpiresAt: undefined,
        offerName: undefined,
        assignmentVersion: input.version + 1,
        assignedAt: new Date(),
        waiterId: owner.waiterId,
        waiterName: owner.waiterName,
        greetedAt: undefined,
      });
      await v.save({ session });
      await recordNotice(
        session,
        v._id,
        'assigned',
        v.waiterId,
        req.user!.id,
        input.previous,
        input.overrideReason,
      );
      return { waiterName: v.waiterName };
    });
    return ok(res, visit);
  }),
);
router.post(
  '/tasks/:id',
  asyncHandler(async (req, res) => {
    const next = z.enum(['acknowledged', 'completed']).parse(req.body.state);
    const task = await mongoose.connection.transaction(async (session) => {
      const t = await ServiceTask.findById(id.parse(req.params.id)).session(session);
      if (!t) throw AppError.notFound('Request not found');
      const v = await TableSessionModel.findOneAndUpdate(
        { _id: t.visit, status: 'open', qrService: true },
        { $inc: { serviceVersion: 1 } },
        { session },
      );
      if (!v) throw AppError.conflict('Visit is closed');
      if (t.state === next) return t;
      if (t.state !== (next === 'completed' ? 'acknowledged' : 'requested'))
        throw AppError.conflict('Refresh this request');
      const actor = new Types.ObjectId(req.user!.id);
      if (next === 'completed') {
        t.completedAt = new Date();
        t.completedBy = actor;
      } else {
        t.acknowledgedAt = new Date();
        t.acknowledgedBy = actor;
      }
      t.state = next;
      return t.save({ session });
    });
    return ok(res, { state: task.state });
  }),
);
router.get(
  '/roster',
  asyncHandler(async (_req, res) => {
    const role = await RoleModel.findOne({ key: 'waiter' }).lean();
    const eligible =
      role && (await UserModel.find({ roleId: role._id, isActive: true }).distinct('_id'));
    return ok(
      res,
      await ShiftModel.find({ status: 'open', userId: { $in: eligible ?? [] } })
        .select('userId serviceZone serviceOverflow maxServiceTables maxServiceCovers breaks')
        .populate('userId', 'name')
        .lean(),
    );
  }),
);
router.put(
  '/roster/:id',
  requirePermission('user:update'),
  asyncHandler(async (req, res) => {
    const profile = z
      .object({
        serviceZone: z.string().trim().max(80),
        serviceOverflow: z.boolean(),
        maxServiceTables: z.number().int().min(1).max(100),
        maxServiceCovers: z.number().int().min(1).max(500),
      })
      .parse(req.body);
    const shift = await ShiftModel.findOneAndUpdate(
      { _id: id.parse(req.params.id), status: 'open' },
      { $set: profile },
      { new: true },
    );
    if (!shift) throw AppError.conflict('The shift is closed');
    return ok(res, { id: shift._id });
  }),
);
export default router;
