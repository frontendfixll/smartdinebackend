import { hasPermission } from '@modules/roles/permissions';
import { Request, Response } from 'express';
import { asyncHandler } from '@utils/asyncHandler';
import { ok, created, paginated } from '@utils/apiResponse';
import * as svc from './invoice.service';
import { generateInvoicePdf } from './invoicePdf.service';
import { InvoiceModel } from './invoice.model';
import { AppError } from '@utils/AppError';
import { OrderModel } from '@modules/orders/order.model';

const ctx = (req: Request) => ({
  actorId: req.user?.id,
  actorEmail: req.user?.email,
  actorRole: req.user?.role.key,
  actorName: req.user?.name,
});

export const getForOrder = asyncHandler(async (req: Request, res: Response) => {
  if (!(await OrderModel.exists({ _id: req.params.id })))
    throw AppError.notFound('Order not found');
  return ok(res, await InvoiceModel.findOne({ orderId: req.params.id, status: 'final' }));
});

export const generateForOrder = asyncHandler(async (req: Request, res: Response) => {
  const permissions = req.user?.role.permissions ?? [];
  if (req.body.discount !== undefined && !hasPermission(permissions, 'billing:discount'))
    throw AppError.forbidden('Manual discounts require manager permission');
  if ((req.body.discountId || req.body.couponCode) && !hasPermission(permissions, 'discount:apply'))
    throw AppError.forbidden('Discount application is not allowed for this role');
  if (req.body.loyaltyPoints && !hasPermission(permissions, 'loyalty:redeem'))
    throw AppError.forbidden('Loyalty redemption is not allowed for this role');
  const invoice = await svc.generateInvoiceForOrder(
    { orderId: req.params.id, ...req.body },
    ctx(req),
  );
  return created(res, invoice);
});

export const split = asyncHandler(async (req: Request, res: Response) => {
  return ok(res, await svc.splitInvoice(req.params.id, req.body, ctx(req)));
});

export const applyDiscount = asyncHandler(async (req: Request, res: Response) => {
  return ok(res, await svc.applyDiscount(req.params.id, req.body.amount, ctx(req)));
});

export const clearPromotions = asyncHandler(async (req: Request, res: Response) => {
  return ok(res, await svc.removeInvoicePromotions(req.params.id, ctx(req)));
});

export const voidInvoice = asyncHandler(async (req: Request, res: Response) => {
  return ok(res, await svc.voidInvoice(req.params.id, req.body.reason, ctx(req)));
});

export const list = asyncHandler(async (req: Request, res: Response) => {
  const { items, meta } = await svc.listInvoices(req.query as svc.ListInvoicesOpts);
  return paginated(res, items, meta);
});

export const getOne = asyncHandler(async (req: Request, res: Response) => {
  return ok(res, await svc.getInvoice(req.params.id));
});

export const downloadPdf = asyncHandler(async (req: Request, res: Response) => {
  const invoice = await InvoiceModel.findById(req.params.id);
  if (!invoice) throw AppError.notFound('Invoice not found');
  const pdf = await generateInvoicePdf(invoice);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `inline; filename="${invoice.invoiceNumber.replace(/[\\/]/g, '-')}.pdf"`,
  );
  res.send(pdf);
});

export const setTip = asyncHandler(async (req: Request, res: Response) =>
  ok(res, await svc.setInvoiceTip(req.params.id, req.body.amount, ctx(req))),
);
