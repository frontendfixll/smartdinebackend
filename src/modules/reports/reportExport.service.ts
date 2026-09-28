import { Agenda, Job } from 'agenda';
import { InvoiceModel } from '@modules/invoices/invoice.model';
import { OrderModel } from '@modules/orders/order.model';
import { round2 } from '@utils/math';

export interface ExportJob {
  type: 'sales' | 'orders' | 'inventory';
  startDate: Date;
  endDate: Date;
  status: 'pending' | 'completed' | 'failed';
  filePath?: string;
  createdBy: string;
  createdAt: Date;
}

export async function generateSalesReport(startDate: Date, endDate: Date) {
  const invoices = await InvoiceModel.find({
    issueDate: { $gte: startDate, $lte: endDate },
    status: 'final',
  }).lean();

  const summary = {
    period: { start: startDate, end: endDate },
    totalInvoices: invoices.length,
    totalRevenue: 0,
    totalTax: 0,
    totalDiscount: 0,
    totalTip: 0,
    channelBreakup: {} as Record<string, number>,
  };

  for (const invoice of invoices) {
    summary.totalRevenue += invoice.grand;
    summary.totalTax += invoice.tax;
    summary.totalDiscount += invoice.discount;
    summary.totalTip += invoice.tip || 0;
    summary.channelBreakup[invoice.channel] =
      (summary.channelBreakup[invoice.channel] || 0) + invoice.grand;
  }

  return {
    ...summary,
    averageOrderValue: round2(summary.totalRevenue / invoices.length || 0),
    invoiceCount: invoices.length,
  };
}

export async function generateOrdersReport(startDate: Date, endDate: Date) {
  const orders = await OrderModel.find({
    createdAt: { $gte: startDate, $lte: endDate },
  }).lean();

  const summary = {
    period: { start: startDate, end: endDate },
    totalOrders: orders.length,
    byStatus: {} as Record<string, number>,
    byChannel: {} as Record<string, number>,
  };

  for (const order of orders) {
    summary.byStatus[order.status] = (summary.byStatus[order.status] || 0) + 1;
    summary.byChannel[order.channel] = (summary.byChannel[order.channel] || 0) + 1;
  }

  return summary;
}

export async function initializeAgenda(mongoUrl: string) {
  const agenda = new Agenda({ db: { address: mongoUrl } });

  agenda.define('export-sales-report', async (job: Job<{ startDate: string; endDate: string }>) => {
    const { startDate, endDate } = job.attrs.data;
    console.log(`[Report] Sales report: ${startDate} to ${endDate}`);
  });

  agenda.define(
    'export-orders-report',
    async (job: Job<{ startDate: string; endDate: string }>) => {
      const { startDate, endDate } = job.attrs.data;
      console.log(`[Report] Orders report: ${startDate} to ${endDate}`);
    },
  );

  return agenda;
}
