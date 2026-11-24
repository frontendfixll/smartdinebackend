import { z } from 'zod';
import { QrCodeModel } from '@modules/qr/qrCode.model';
import { TableModel } from '@modules/tables/table.model';
import { TableSessionModel } from '@modules/tables/tableSession.model';
import { AppError } from '@utils/AppError';
import { pilotZone } from './assignment';

const slug = z.string().min(3).max(20);
export async function entry(rawSlug: unknown) {
  const qr = await QrCodeModel.findOne({
    slug: slug.parse(rawSlug),
    type: 'table',
    isActive: true,
  }).lean();
  let table = qr?.tableId && (await TableModel.findOne({ _id: qr.tableId, isActive: true }).lean());
  if (table?.mergedIntoTableId)
    table = await TableModel.findOne({ _id: table.mergedIntoTableId, isActive: true }).lean();
  if (!table) throw AppError.notFound('Active table QR not found');
  const visit =
    table.currentSessionId &&
    (await TableSessionModel.findOne({
      _id: table.currentSessionId,
      tableId: table._id,
      status: 'open',
    }).lean());
  // Open visits keep their enrollment through moves and configuration changes.
  return {
    table,
    visit,
    enrolled: visit
      ? !!visit.qrService
      : pilotZone(table.zone) && process.env.QR_SERVICE_MODE === 'live',
  };
}
