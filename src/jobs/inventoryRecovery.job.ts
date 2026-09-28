import Agenda from 'agenda';
import { OrderModel } from '@modules/orders/order.model';
import { deductOrderInventory } from '@modules/inventory/inventoryDeduction.service';
import { logger } from '@utils/logger';
/** Recover deductions interrupted after payment/settlement, including process restarts. */
export function defineInventoryRecoveryJob(agenda: Agenda) {
  agenda.define('recover-order-inventory', async () => {
    const orders = await OrderModel.find({
      status: 'settled',
      inventoryDeductedAt: { $exists: false },
      $or: [{ inventoryRetryAt: { $exists: false } }, { inventoryRetryAt: { $lte: new Date() } }],
    })
      .sort({ updatedAt: 1 })
      .limit(50)
      .select('_id');
    for (const order of orders) {
      try {
        await deductOrderInventory(order._id);
      } catch (error) {
        await OrderModel.updateOne(
          { _id: order._id },
          { $set: { inventoryRetryAt: new Date(Date.now() + 15 * 60000) } },
        );
        logger.error(
          { orderId: String(order._id), error },
          'Inventory recovery requires retry or reconciliation',
        );
      }
    }
  });
}
