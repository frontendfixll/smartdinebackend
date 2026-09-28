import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '@middleware/requireAuth';
import { requirePermission } from '@middleware/requirePermission';
import { validate } from '@middleware/validate';
import { asyncHandler } from '@utils/asyncHandler';
import { ok, created } from '@utils/apiResponse';
import { mongoId } from '@utils/zod';
import { AppError } from '@utils/AppError';
import { SupplierModel, PurchaseOrderModel, GoodsReceiptModel } from './purchasing.model';
import { createPurchase, changePurchase, receivePurchase } from './purchasing.service';
import { writeAuditLog } from '@modules/audit/audit.service';
const router = Router();
router.use(requireAuth);
const id = z.object({ id: mongoId() });
const supplier = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().email().optional(),
  phone: z.string().max(40).optional(),
  address: z.string().max(500).optional(),
  notes: z.string().max(1000).optional(),
  isActive: z.boolean().optional(),
});
router.get(
  '/suppliers',
  requirePermission('inventory:read'),
  asyncHandler(async (_req, res) =>
    ok(res, await SupplierModel.find().sort({ name: 1 }).limit(500).lean()),
  ),
);
router.post(
  '/suppliers',
  requirePermission('inventory:create'),
  validate(supplier),
  asyncHandler(async (req, res) => {
    const s = await SupplierModel.create(req.body);
    await writeAuditLog({
      actorId: req.user!.id,
      action: 'supplier.create',
      entity: 'Supplier',
      entityId: String(s._id),
    });
    return created(res, s);
  }),
);
router.patch(
  '/suppliers/:id',
  requirePermission('inventory:update'),
  validate(id, 'params'),
  validate(supplier.partial()),
  asyncHandler(async (req, res) => {
    const s = await SupplierModel.findByIdAndUpdate(
      req.params.id,
      { $set: req.body },
      { new: true, runValidators: true },
    );
    if (!s) throw AppError.notFound('Supplier not found');
    await writeAuditLog({
      actorId: req.user!.id,
      action: 'supplier.update',
      entity: 'Supplier',
      entityId: String(s._id),
      after: req.body,
    });
    return ok(res, s);
  }),
);
router.get(
  '/orders',
  requirePermission('inventory:read'),
  asyncHandler(async (_req, res) =>
    ok(res, await PurchaseOrderModel.find().sort({ createdAt: -1 }).limit(100).lean()),
  ),
);
router.get(
  '/orders/:id/receipts',
  requirePermission('inventory:read'),
  validate(id, 'params'),
  asyncHandler(async (req, res) =>
    ok(
      res,
      await GoodsReceiptModel.find({ purchaseOrderId: req.params.id })
        .sort({ createdAt: -1 })
        .select('-operationKey -requestHash')
        .lean(),
    ),
  ),
);
const quantity = z
  .number()
  .positive()
  .max(1000000)
  .refine(
    (n) => Math.abs(Math.round(n * 1000) - n * 1000) < 0.000001,
    'Use up to three decimal places',
  );
router.post(
  '/orders',
  requirePermission('inventory:create'),
  validate(
    z.object({
      supplierId: mongoId(),
      expectedAt: z.coerce.date().optional(),
      notes: z.string().max(1000).optional(),
      items: z
        .array(
          z.object({
            inventoryItemId: mongoId(),
            quantity,
            unitCost: z.number().min(0).max(1000000),
          }),
        )
        .min(1)
        .max(100)
        .refine(
          (lines) => new Set(lines.map((l) => l.inventoryItemId)).size === lines.length,
          'Combine duplicate ingredients',
        ),
    }),
  ),
  asyncHandler(async (req, res) => created(res, await createPurchase(req.body, req.user!.id))),
);
router.patch(
  '/orders/:id',
  requirePermission('inventory:update'),
  validate(id, 'params'),
  validate(
    z.object({ status: z.enum(['ordered', 'cancelled']), reason: z.string().max(500).optional() }),
  ),
  asyncHandler(async (req, res) =>
    ok(res, await changePurchase(req.params.id, req.body.status, req.body.reason, req.user!.id)),
  ),
);
router.post(
  '/orders/:id/receive',
  requirePermission('inventory:stockin'),
  validate(id, 'params'),
  validate(
    z.object({
      supplierInvoice: z.string().max(100).optional(),
      notes: z.string().max(1000).optional(),
      items: z
        .array(z.object({ lineId: mongoId(), quantity }))
        .min(1)
        .max(100)
        .refine(
          (lines) => new Set(lines.map((l) => l.lineId)).size === lines.length,
          'Duplicate receipt lines',
        ),
    }),
  ),
  asyncHandler(async (req, res) =>
    ok(
      res,
      await receivePurchase(req.params.id, req.body, req.user!.id, req.get('Idempotency-Key')),
    ),
  ),
);
export default router;
