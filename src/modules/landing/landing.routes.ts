import { Router } from 'express';
import { requireAuth } from '@middleware/requireAuth';
import { requirePermission } from '@middleware/requirePermission';
import { validate } from '@middleware/validate';
import { uploadImage, requireCloudinary } from '@middleware/upload';
import { publicReadLimiter } from '@middleware/rateLimits';
import * as ctrl from './landing.controller';
import * as v from './landing.validators';

const router = Router();

// Public: landing CMS content (gallery + how-it-works + hero copy).
router.get('/public', publicReadLimiter, ctrl.getPublic);

router.patch(
  '/',
  requireAuth,
  requirePermission('landing:update'),
  validate(v.updateLandingSchema),
  ctrl.update,
);

router.post(
  '/gallery',
  requireAuth,
  requirePermission('landing:update'),
  requireCloudinary,
  uploadImage.single('image'),
  ctrl.uploadGallery,
);

router.delete(
  '/gallery/:id',
  requireAuth,
  requirePermission('landing:update'),
  validate(v.galleryItemIdParamSchema, 'params'),
  ctrl.deleteGallery,
);

export default router;
