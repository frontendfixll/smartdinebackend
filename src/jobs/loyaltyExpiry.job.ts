import { Agenda } from 'agenda';
import { expireStalePoints } from '@modules/promotions/loyalty.service';
import { logger } from '@utils/logger';

export function defineLoyaltyExpiryJob(agenda: Agenda) {
  agenda.define('expire-loyalty-points', async () => {
    try {
      const result = await expireStalePoints();
      if (result.expiredAccounts > 0)
        logger.info(result, 'Loyalty points expired for inactive accounts');
    } catch (err) {
      logger.error({ err }, 'Failed to expire loyalty points');
      throw err;
    }
  });
}
