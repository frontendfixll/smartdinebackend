import { Request, Response } from 'express';
import { asyncHandler } from '@utils/asyncHandler';
import { ok } from '@utils/apiResponse';
import * as svc from './inventorySnapshot.service';

export const captureSnapshot = asyncHandler(async (_req: Request, res: Response) => {
  const snapshot = await svc.captureInventorySnapshot();
  return ok(res, snapshot);
});

export const getHistory = asyncHandler(async (req: Request, res: Response) => {
  const days = parseInt((req.query.days as string) || '30');
  const snapshots = await svc.getSnapshotHistory(days);
  return ok(res, { snapshots, count: snapshots.length });
});

export const getVariance = asyncHandler(async (req: Request, res: Response) => {
  const { itemId } = req.params;
  const days = parseInt((req.query.days as string) || '30');
  const variance = await svc.getInventoryVariance(itemId, days);
  return ok(res, variance);
});
