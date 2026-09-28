import { AppError } from '@utils/AppError';
import { InvoiceModel } from '@modules/invoices/invoice.model';
import { config } from '@config/index';
import { writeAuditLog } from '@modules/audit/audit.service';

export interface SharePayload {
  invoiceId: string;
  phone?: string;
  email?: string;
  channel: 'whatsapp' | 'sms' | 'email';
}

export async function generateBillLink(invoiceId: string): Promise<string> {
  const invoice = await InvoiceModel.findById(invoiceId);
  if (!invoice) throw AppError.notFound('Invoice not found');
  return `${config.urls.publicBase}/bill/${invoiceId}`;
}

export async function shareBillViaWhatsApp(invoiceId: string, phone: string) {
  if (!phone.match(/^\+?[1-9]\d{7,14}$/)) {
    throw AppError.badRequest('Invalid phone number');
  }

  const invoice = await InvoiceModel.findById(invoiceId);
  if (!invoice) throw AppError.notFound('Invoice not found');

  const billLink = await generateBillLink(invoiceId);
  const message = encodeURIComponent(
    `Your bill from ${invoice.restaurantSnapshot.name}\n\nOrder #${invoice.orderNumberSnapshot}\nTotal: ₹${invoice.grand}\n\nView full bill: ${billLink}`,
  );

  return {
    channel: 'whatsapp',
    phone,
    url: `https://wa.me/${phone.replace(/\D/g, '')}?text=${message}`,
    message: `Bill shared via WhatsApp to ${phone}`,
  };
}

export async function shareBillViaSms(invoiceId: string, phone: string) {
  if (!phone.match(/^\+?[1-9]\d{7,14}$/)) {
    throw AppError.badRequest('Invalid phone number');
  }

  const invoice = await InvoiceModel.findById(invoiceId);
  if (!invoice) throw AppError.notFound('Invoice not found');

  const billLink = await generateBillLink(invoiceId);
  const message = `Bill from ${invoice.restaurantSnapshot.name} - Order #${invoice.orderNumberSnapshot} - ₹${invoice.grand} - View: ${billLink}`;

  return {
    channel: 'sms',
    phone,
    url: `sms:${phone}?body=${encodeURIComponent(message)}`,
    message: `Bill shared via SMS to ${phone}`,
    smsText: message,
  };
}

export async function shareBillViaEmail(invoiceId: string, email: string) {
  if (!email.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) {
    throw AppError.badRequest('Invalid email address');
  }

  const invoice = await InvoiceModel.findById(invoiceId);
  if (!invoice) throw AppError.notFound('Invoice not found');

  const billLink = await generateBillLink(invoiceId);
  const subject = `Your Bill from ${invoice.restaurantSnapshot.name}`;
  const body = `
Order #${invoice.orderNumberSnapshot}
Total: ₹${invoice.grand}

View your full bill: ${billLink}

Thank you for your visit!
${invoice.restaurantSnapshot.name}
`;

  return {
    channel: 'email',
    email,
    url: `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`,
    message: `Bill shared via email to ${email}`,
  };
}

export async function recordBillShare(
  invoiceId: string,
  channel: 'whatsapp' | 'sms' | 'email',
  recipient: string,
  actorId?: string,
) {
  const invoice = await InvoiceModel.findById(invoiceId);
  if (!invoice) throw AppError.notFound('Invoice not found');

  if (!invoice.billShares) invoice.billShares = [];
  invoice.billShares.push({
    channel,
    recipient,
    sharedAt: new Date(),
  });
  await invoice.save();

  if (actorId) {
    await writeAuditLog({
      actorId,
      action: 'invoice.bill_share',
      entity: 'Invoice',
      entityId: String(invoice._id),
      metadata: { channel, recipient },
    });
  }

  return invoice;
}
