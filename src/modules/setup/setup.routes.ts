import { Router } from 'express';
import mongoose from 'mongoose';
import { config } from '@config/index';
import { requireAuth } from '@middleware/requireAuth';
import { requirePermission } from '@middleware/requirePermission';
import { asyncHandler } from '@utils/asyncHandler';
import { ok } from '@utils/apiResponse';
import { getOrCreateRestaurant } from '@modules/restaurant/restaurant.service';
import { ItemModel } from '@modules/menu/item.model';
import { TableModel } from '@modules/tables/table.model';
import { InvoiceModel } from '@modules/invoices/invoice.model';
import { PaymentModel } from '@modules/payments/payment.model';
import { RefundModel } from '@modules/payments/refund.model';
import { CashSessionModel } from '@modules/cashSessions/cashSession.model';
import { StockMovementModel } from '@modules/inventory/stockMovement.model';
import { ShiftModel } from '@modules/shifts/shift.model';
import { GoodsReceiptModel } from '@modules/purchasing/purchasing.model';
import { DayCloseModel } from '@modules/billing/dayClose.model';
import { DeliveryModel } from '@modules/delivery/delivery.model';
import { deliveryConfig } from '@modules/delivery/delivery.service';
import { RoleModel } from '@modules/roles/role.model';
import { BUILT_IN_ROLES } from '@modules/roles/builtInRoles';

const router = Router();
router.use(requireAuth, requirePermission('restaurant:update'));
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return JSON.stringify(value.map(canonical));
  if (value && typeof value === 'object')
    return JSON.stringify(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return JSON.stringify(value);
};
router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const restaurant = await getOrCreateRestaurant();
    const [itemCount, tableCount, delivery, roles] = await Promise.all([
      ItemModel.countDocuments({ isActive: true }),
      TableModel.countDocuments({ isActive: true }),
      deliveryConfig(),
      RoleModel.find().select('key permissions').lean(),
    ]);
    const missingIndexes: string[] = [];
    for (const model of [
      InvoiceModel,
      PaymentModel,
      RefundModel,
      CashSessionModel,
      StockMovementModel,
      ShiftModel,
      GoodsReceiptModel,
      DayCloseModel,
      DeliveryModel,
    ]) {
      const actual = await model.collection.indexes().catch(() => []);
      for (const [key, options] of model.schema.indexes().filter(([, o]) => o.unique)) {
        if (
          !actual.some(
            (i) =>
              i.unique &&
              canonical(i.key) === canonical(key) &&
              canonical(i.partialFilterExpression) === canonical(options.partialFilterExpression) &&
              !!i.sparse === !!options.sparse,
          )
        )
          missingIndexes.push(`${model.modelName}: ${Object.keys(key).join(', ')}`);
      }
    }
    const missingRoles = BUILT_IN_ROLES.filter(
      (def) => !roles.some((role) => role.key === def.key),
    ).map((def) => def.name);
    const manager = roles.find((role) => role.key === 'manager');
    const missingManagerPermissions =
      manager && !manager.permissions.includes('*')
        ? ['shift:read', 'reservation:create', 'delivery:read', 'delivery:manage'].filter(
            (p) => !manager.permissions.includes(p),
          )
        : [];
    const topology: { setName?: string; msg?: string } = await mongoose.connection
      .db!.admin()
      .command({ hello: 1 })
      .catch(() => ({}));
    type Check = {
      key: string;
      title: string;
      status: 'configured' | 'needs_setup' | 'needs_integration' | 'unverified';
      detail: string;
      link?: string;
    };
    const checks: Check[] = [
      {
        key: 'profile',
        title: 'Restaurant contact and hours',
        status:
          restaurant.brand.address &&
          restaurant.brand.contactPhone &&
          restaurant.brand.openingHours.length === 7
            ? 'configured'
            : 'needs_setup',
        detail: 'Confirm the street address, contact number and all seven operating days.',
        link: '/admin/settings',
      },
      {
        key: 'currency',
        title: 'USD and Pacific time',
        status:
          restaurant.currency === 'USD' && restaurant.timeZone === 'America/Los_Angeles'
            ? 'configured'
            : 'needs_setup',
        detail: `${restaurant.currency} · ${restaurant.timeZone}. Existing amounts require a reviewed migration before changing currency.`,
        link: '/admin/settings',
      },
      {
        key: 'tax',
        title: 'Sales tax and fee policy',
        status: restaurant.tax.taxes.length ? 'configured' : 'needs_setup',
        detail:
          'Configured rates still require restaurant review. Item-specific tax treatment and charge disclosures remain release work.',
        link: '/admin/settings',
      },
      {
        key: 'menu',
        title: 'Menu catalog',
        status: itemCount ? 'configured' : 'needs_setup',
        detail: `${itemCount} active items. Verify prices, modifiers, availability, allergens and recipes with the restaurant.`,
        link: '/admin/menu',
      },
      {
        key: 'tables',
        title: 'Tables and reservations',
        status: tableCount ? 'configured' : 'needs_setup',
        detail: `${tableCount} active tables. Confirm physical capacities and service durations.`,
        link: '/admin/tables',
      },
      {
        key: 'database',
        title: 'Database transactions',
        status: topology.setName || topology.msg === 'isdbgrid' ? 'configured' : 'needs_setup',
        detail:
          'Financial and stock workflows require a MongoDB replica set or supported sharded cluster.',
      },
      {
        key: 'indexes',
        title: 'Financial uniqueness safeguards',
        status: missingIndexes.length ? 'needs_setup' : 'configured',
        detail: missingIndexes.length
          ? `Missing database indexes: ${missingIndexes.join('; ')}`
          : 'Required unique indexes are present. This check does not change the database.',
      },
      {
        key: 'roles',
        title: 'Staff roles',
        status:
          missingRoles.length || missingManagerPermissions.length ? 'needs_setup' : 'configured',
        detail: [
          missingRoles.length
            ? `Missing roles: ${missingRoles.join(', ')}.`
            : 'Built-in role definitions are present.',
          missingManagerPermissions.length
            ? `Manager permissions to review: ${missingManagerPermissions.join(', ')}.`
            : '',
        ].join(' '),
        link: '/admin/users',
      },
      {
        key: 'card',
        title: 'US card processing',
        status: 'needs_integration',
        detail:
          'Select the processor and terminal model. The current card action records an external terminal receipt; it does not charge a card.',
      },
      {
        key: 'printer',
        title: 'Receipt printer and cash drawer',
        status: 'needs_integration',
        detail:
          'Select devices and connection method. PDF receipts work; printer delivery and drawer opening are not implemented.',
      },
      {
        key: 'sms',
        title: 'SMS delivery',
        status: config.twilio.enabled && !!config.twilio.smsFrom ? 'unverified' : 'needs_setup',
        detail: config.twilio.enabled
          ? 'Provider credentials are present. Sender, guest consent, delivery receipts and failure handling need verification.'
          : 'SMS is not configured. Credentials are never returned by this screen.',
      },
      {
        key: 'email',
        title: 'Email delivery',
        status: config.smtp.enabled ? 'unverified' : 'needs_setup',
        detail: config.smtp.enabled
          ? 'Email configuration is present; delivery has not been verified.'
          : 'Configure an approved sender before sending notifications.',
      },
      {
        key: 'delivery',
        title: 'Staff-arranged delivery',
        status: delivery.enabled ? 'configured' : 'needs_setup',
        detail:
          'Prepaid orders, confirmed addresses, ZIP coverage and assigned staff dispatch. Self-service delivery checkout, delivery fees, address verification services and marketplace integrations remain separate work.',
        link: '/admin/delivery',
      },
      {
        key: 'release',
        title: 'Operational acceptance',
        status: 'unverified',
        detail:
          'Still required: integer-cent migration, complete refund/promotion policies, offline recovery, supported-device checks, backup restore and full-shift acceptance.',
      },
    ];
    return ok(res, {
      checkedAt: new Date(),
      checks,
      note: 'Configured means a setting or local safeguard is present. It does not certify production readiness.',
    });
  }),
);
export default router;
