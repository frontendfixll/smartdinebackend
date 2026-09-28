import { Request, Response } from 'express';
import { asyncHandler } from '@utils/asyncHandler';
import { ok } from '@utils/apiResponse';
import { AppError } from '@utils/AppError';
import {
  shareBillViaWhatsApp,
  shareBillViaSms,
  shareBillViaEmail,
  recordBillShare,
} from './billShare.service';
import { InvoiceModel } from '@modules/invoices/invoice.model';

export const shareBill = asyncHandler(async (req: Request, res: Response) => {
  const { invoiceId, channel, phone, email } = req.body;

  let result: any;
  const recipient = channel === 'email' ? email : phone;

  if (channel === 'whatsapp') {
    if (!phone) throw AppError.badRequest('Phone number required for WhatsApp');
    result = await shareBillViaWhatsApp(invoiceId, phone);
  } else if (channel === 'sms') {
    if (!phone) throw AppError.badRequest('Phone number required for SMS');
    result = await shareBillViaSms(invoiceId, phone);
  } else if (channel === 'email') {
    if (!email) throw AppError.badRequest('Email required for email share');
    result = await shareBillViaEmail(invoiceId, email);
  }

  await recordBillShare(invoiceId, channel, recipient!, req.user?.id);
  return ok(res, { ...result, recorded: true });
});

export const getBillShares = asyncHandler(async (req: Request, res: Response) => {
  const invoice = await InvoiceModel.findById(req.params.invoiceId);
  if (!invoice) throw AppError.notFound('Invoice not found');

  return ok(res, {
    invoiceId: String(invoice._id),
    shares: invoice.billShares || [],
  });
});
