import { Router } from 'express';
import { requireAuth } from '@middleware/requireAuth';
import { requirePermission } from '@middleware/requirePermission';
import { validate } from '@middleware/validate';
import { asyncHandler } from '@utils/asyncHandler';
import { ok } from '@utils/apiResponse';
import { AppError } from '@utils/AppError';
import { getOrCreateRestaurant } from '@modules/restaurant/restaurant.service';
import * as svc from './reports.service';
import * as v from './reports.validators';
import { reportToCsv, reportToXlsx, reportToPdf } from './reports.exporters';
const router = Router();
router.use(requireAuth);
const reports = {
  sales: svc.salesReport,
  items: svc.itemsReport,
  tax: svc.taxReport,
  payments: svc.paymentsReport,
  staff: svc.staffReport,
  footfall: svc.footfallReport,
  inventory: svc.inventoryReport,
  feedback: svc.feedbackReport,
  profitability: svc.profitabilityReport,
};
router.get(
  '/kpi-dashboard',
  requirePermission('report:read'),
  asyncHandler(async (_req, res) => ok(res, await svc.kpiDashboard())),
);
for (const [type, build] of Object.entries(reports)) {
  const schema =
    type === 'sales' ? v.salesQuerySchema : type === 'items' ? v.itemsQuerySchema : v.baseRange;
  router.get(
    `/${type}`,
    requirePermission('report:read'),
    validate(schema, 'query'),
    asyncHandler(async (req, res) => {
      const query = req.query as unknown as svc.SalesReportOpts;
      if (query.from && query.to && query.from > query.to)
        throw AppError.badRequest('Start date must precede end date');
      const currency = query.currency ?? (await getOrCreateRestaurant()).currency;
      return ok(res, { ...(await build(query)), currency, timeZone: 'America/Los_Angeles' });
    }),
  );
  router.get(
    `/${type}/export`,
    requirePermission('report:export'),
    validate(v.exportQuerySchema, 'query'),
    asyncHandler(async (req, res) => {
      const query = req.query as unknown as svc.SalesReportOpts;
      if (query.from && query.to && query.from > query.to)
        throw AppError.badRequest('Start date must precede end date');
      const currency = query.currency ?? (await getOrCreateRestaurant()).currency;
      const report = {
        ...(await build(query)),
        metadata: [
          {
            currency,
            timeZone: 'America/Los_Angeles',
            from: query.from?.toISOString(),
            to: query.to?.toISOString(),
          },
        ],
      };
      const format = String(req.query.format);
      const buffer =
        format === 'pdf'
          ? await reportToPdf(`${type} report · ${currency} · Pacific time`, report)
          : format === 'xlsx'
            ? reportToXlsx(report)
            : reportToCsv(report);
      res.setHeader(
        'Content-Type',
        format === 'pdf'
          ? 'application/pdf'
          : format === 'xlsx'
            ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            : 'text/csv; charset=utf-8',
      );
      res.setHeader('Content-Disposition', `attachment; filename="${type}-${currency}.${format}"`);
      return res.send(buffer);
    }),
  );
}
export default router;
