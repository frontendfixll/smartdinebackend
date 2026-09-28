import { asyncHandler } from '@utils/asyncHandler';
import { ok } from '@utils/apiResponse';
import { buildDayClose, recordDayClose, reopenDayClose } from './dayClose.service';
import { DayCloseModel } from './dayClose.model';
export const preview = asyncHandler(async (req, res) =>
  ok(res, await buildDayClose(req.query.date as string | undefined)),
);
export const close = asyncHandler(async (req, res) =>
  ok(
    res,
    await recordDayClose(req.body.date, {
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      actorRole: req.user!.role.key,
    }),
  ),
);
export const reopen = asyncHandler(async (req, res) =>
  ok(
    res,
    await reopenDayClose(req.body.date, req.body.reason, {
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      actorRole: req.user!.role.key,
    }),
  ),
);
export const history = asyncHandler(async (_req, res) =>
  ok(res, await DayCloseModel.find().sort({ businessDate: -1 }).limit(100).lean()),
);
