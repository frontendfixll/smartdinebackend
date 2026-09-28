import { Request, Response } from 'express';
import { asyncHandler } from '@utils/asyncHandler';
import { ok, created } from '@utils/apiResponse';
import * as svc from './tip.service';
import type { TipPoolMethod } from './tipPayout.model';

const ctx = (req: Request) => ({
  actorId: req.user?.id,
  actorEmail: req.user?.email,
  actorRole: req.user?.role.key,
  actorName: req.user?.name,
});

const method = (v: unknown): TipPoolMethod => (v === 'equal' ? 'equal' : 'hours');

export const preview = asyncHandler(async (req: Request, res: Response) => {
  const result = await svc.previewTipPool(
    String(req.query.businessDate ?? ''),
    method(req.query.method),
  );
  return ok(res, result);
});

export const save = asyncHandler(async (req: Request, res: Response) => {
  const result = await svc.saveTipPool(
    String(req.body.businessDate ?? ''),
    method(req.body.method),
    ctx(req),
  );
  return created(res, result);
});

export const list = asyncHandler(async (_req: Request, res: Response) => {
  return ok(res, await svc.listTipPayouts());
});

export const getOne = asyncHandler(async (req: Request, res: Response) => {
  return ok(res, await svc.getTipPayout(String(req.params.businessDate)));
});
