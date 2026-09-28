import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '@middleware/requireAuth';
import { requirePermission, requireAnyPermission } from '@middleware/requirePermission';
import { validate } from '@middleware/validate';
import { asyncHandler } from '@utils/asyncHandler';
import { ok } from '@utils/apiResponse';
import { mongoId } from '@utils/zod';
import { hasPermission } from '@modules/roles/permissions';
import { DELIVERY_STATES, DeliveryModel } from './delivery.model';
import * as service from './delivery.service';

const router = Router();
router.use(requireAuth);
const zip = z.string().regex(/^\d{5}$/, 'Use a five-digit ZIP code');
const money = z.number().finite().min(0).max(10000).multipleOf(0.01);
router.get(
  '/config',
  requirePermission('delivery:read'),
  asyncHandler(async (_req, res) => ok(res, await service.deliveryConfig())),
);
router.patch(
  '/config',
  requirePermission('restaurant:update'),
  validate(
    z
      .object({
        enabled: z.boolean(),
        postalCodes: z
          .array(zip)
          .max(100)
          .transform((v) => [...new Set(v)]),
        minimumOrder: money,
        noAdditionalFee: z.boolean(),
        instructions: z.string().max(1000),
      })
      .strict(),
  ),
  asyncHandler(async (req, res) =>
    ok(res, await service.saveDeliveryConfig(req.body, req.user!.id)),
  ),
);
router.get(
  '/drivers',
  requirePermission('delivery:manage'),
  asyncHandler(async (_req, res) => ok(res, await service.listDrivers())),
);
router.get(
  '/',
  requirePermission('delivery:read'),
  validate(
    z.object({
      view: z.enum(['active', 'history']).default('active'),
      page: z.coerce.number().int().min(1).default(1),
    }),
    'query',
  ),
  asyncHandler(async (req, res) => {
    const filter = {
      ...(hasPermission(req.user!.role.permissions, 'delivery:manage')
        ? {}
        : { driverId: req.user!.id }),
      status:
        req.query.view === 'history'
          ? { $in: ['delivered', 'cancelled'] }
          : { $nin: ['delivered', 'cancelled'] },
    };
    const page = Number(req.query.page),
      limit = 25;
    const [items, total] = await Promise.all([
      DeliveryModel.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      DeliveryModel.countDocuments(filter),
    ]);
    return ok(res, {
      items,
      meta: { page, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  }),
);
router.post(
  '/',
  requirePermission('delivery:manage'),
  validate(
    z
      .object({
        orderId: mongoId(),
        guestName: z.string().trim().min(1).max(120),
        guestPhone: z.string().regex(/^\+?[1-9]\d{7,14}$/),
        address: z
          .object({
            line1: z.string().trim().min(3).max(180),
            line2: z.string().max(180).optional(),
            city: z.string().trim().min(2).max(80),
            state: z.literal('CA'),
            postalCode: zip,
          })
          .strict(),
        instructions: z.string().max(500).optional(),
        addressConfirmed: z.literal(true),
      })
      .strict(),
  ),
  asyncHandler(async (req, res) =>
    ok(res, await service.createDelivery(req.body, { actorId: req.user!.id, canManage: true })),
  ),
);
router.patch(
  '/:id',
  requireAnyPermission('delivery:manage', 'delivery:fulfill'),
  validate(z.object({ id: mongoId() }), 'params'),
  validate(
    z
      .object({
        status: z.enum(DELIVERY_STATES),
        expectedStatus: z.enum(DELIVERY_STATES),
        driverId: mongoId().optional(),
        note: z.string().trim().max(500).optional(),
        returnedToRestaurant: z.boolean().optional(),
      })
      .strict(),
  ),
  asyncHandler(async (req, res) =>
    ok(
      res,
      await service.changeDelivery(req.params.id, req.body, {
        actorId: req.user!.id,
        canManage: hasPermission(req.user!.role.permissions, 'delivery:manage'),
      }),
    ),
  ),
);
export default router;
