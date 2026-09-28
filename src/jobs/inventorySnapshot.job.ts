import { Agenda } from 'agenda';
import { captureInventorySnapshot } from '@modules/inventory/inventorySnapshot.service';
import { logger } from '@utils/logger';

export function defineInventorySnapshotJob(agenda: Agenda) {
  agenda.define('capture-inventory-snapshot', async () => {
    try {
      const snapshot = await captureInventorySnapshot();
      logger.info(
        { snapshotId: snapshot._id, itemCount: snapshot.items.length },
        'Inventory snapshot captured',
      );
    } catch (err) {
      logger.error({ err }, 'Failed to capture inventory snapshot');
      throw err;
    }
  });
}
