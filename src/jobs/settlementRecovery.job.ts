import Agenda from 'agenda';
import { OrderModel } from '@modules/orders/order.model';
import { maybeSettleOrder } from '@modules/payments/payment.service';
import { logger } from '@utils/logger';

export function defineSettlementRecoveryJob(agenda: Agenda) {
  agenda.define('recover-paid-orders', async () => {
    const orders = await OrderModel.find({ status: 'served', paymentStatus: 'paid' })
      .sort({ updatedAt: 1 })
      .limit(50)
      .select('_id');
    for (const order of orders) {
      try {
        await maybeSettleOrder(order._id, {});
      } catch (error) {
        logger.error({ orderId: String(order._id), error }, 'Settlement recovery failed');
      }
    }
  });
}
