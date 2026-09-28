import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '@middleware/requireAuth';
import { requirePermission } from '@middleware/requirePermission';
import { validate } from '@middleware/validate';
import { asyncHandler } from '@utils/asyncHandler';
import { ok } from '@utils/apiResponse';
import { mongoId } from '@utils/zod';
import { ShiftModel, shiftSummary } from './shift.model';
import { clockIn, shiftAction } from './shift.service';
const router = Router();
router.use(requireAuth);
router.get(
  '/mine',
  asyncHandler(async (req, res) =>
    ok(
      res,
      (
        await ShiftModel.find({ userId: req.user!.id }).sort({ startedAt: -1 }).limit(50).lean()
      ).map(shiftSummary),
    ),
  ),
);
router.post(
  '/clock-in',
  asyncHandler(async (req, res) => ok(res, await clockIn(req.user!.id))),
);
router.post(
  '/:id/action',
  validate(z.object({ id: mongoId() }), 'params'),
  validate(
    z
      .object({
        action: z.enum(['break_start', 'break_end', 'clock_out']),
        notes: z.string().max(1000).optional(),
      })
      .strict(),
  ),
  asyncHandler(async (req, res) =>
    ok(res, await shiftAction(req.user!.id, req.params.id, req.body.action, req.body.notes)),
  ),
);
router.get(
  '/',
  requirePermission('shift:read'),
  validate(
    z.object({
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
      userId: mongoId().optional(),
    }),
    'query',
  ),
  asyncHandler(async (req, res) => {
    const query: Record<string, unknown> = {};
    if (req.query.userId) query.userId = req.query.userId;
    if (req.query.from || req.query.to)
      query.startedAt = {
        ...(req.query.from ? { $gte: req.query.from } : {}),
        ...(req.query.to ? { $lte: req.query.to } : {}),
      };
    return ok(
      res,
      (
        await ShiftModel.find(query)
          .populate('userId', 'name')
          .sort({ startedAt: -1 })
          .limit(500)
          .lean()
      ).map((s) => shiftSummary(s as unknown as Parameters<typeof shiftSummary>[0])),
    );
  }),
);
export default router;
