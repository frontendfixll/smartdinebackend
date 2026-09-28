import { Request, Response } from 'express';
import { asyncHandler } from '@utils/asyncHandler';
import { ok, noContent } from '@utils/apiResponse';
import { AppError } from '@utils/AppError';
import * as svc from './landing.service';

const ctx = (req: Request) => ({
  actorId: req.user?.id,
  actorEmail: req.user?.email,
  actorRole: req.user?.role.key,
});

export const getPublic = asyncHandler(async (_req: Request, res: Response) => {
  return ok(res, await svc.getLandingContent());
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  return ok(res, await svc.updateLandingContent(req.body, ctx(req)));
});

export const uploadGallery = asyncHandler(async (req: Request, res: Response) => {
  if (!req.file) throw AppError.badRequest('Missing "image" file field');
  return ok(res, await svc.uploadGalleryImage(req.file.buffer, req.file.originalname, ctx(req)));
});

export const deleteGallery = asyncHandler(async (req: Request, res: Response) => {
  await svc.deleteGalleryImage(req.params.id, ctx(req));
  return noContent(res);
});
