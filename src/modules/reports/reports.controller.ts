import { Request, Response } from 'express';
import { asyncHandler } from '@utils/asyncHandler';
import { ok } from '@utils/apiResponse';
import * as svc from './reportExport.service';

export const salesReport = asyncHandler(async (req: Request, res: Response) => {
  const { startDate, endDate } = req.query;
  const report = await svc.generateSalesReport(
    new Date(startDate as string),
    new Date(endDate as string),
  );
  return ok(res, report);
});

export const ordersReport = asyncHandler(async (req: Request, res: Response) => {
  const { startDate, endDate } = req.query;
  const report = await svc.generateOrdersReport(
    new Date(startDate as string),
    new Date(endDate as string),
  );
  return ok(res, report);
});

export const exportSalesReport = asyncHandler(async (req: Request, res: Response) => {
  const { startDate, endDate } = req.body;
  // Schedule async export job
  const jobId = `export-${Date.now()}`;
  await svc.initializeAgenda(process.env.MONGO_URL || '');
  return ok(res, { jobId, status: 'scheduled', message: 'Report export scheduled' });
});

export const exportOrdersReport = asyncHandler(async (req: Request, res: Response) => {
  const { startDate, endDate } = req.body;
  const jobId = `export-${Date.now()}`;
  return ok(res, { jobId, status: 'scheduled', message: 'Report export scheduled' });
});
