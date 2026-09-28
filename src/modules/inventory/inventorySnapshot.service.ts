import { InventorySnapshotModel } from './inventorySnapshot.model';
import { InventoryItemModel } from './inventoryItem.model';
import { round2 } from '@utils/math';

export async function captureInventorySnapshot() {
  const items = await InventoryItemModel.find({ isActive: true }).lean();

  const snapshot = await InventorySnapshotModel.create({
    date: new Date(),
    items: items.map((item) => ({
      itemId: item._id,
      itemName: item.name,
      quantity: item.currentStock,
      unit: item.unit,
    })),
  });

  return snapshot;
}

export async function getSnapshotHistory(days = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const snapshots = await InventorySnapshotModel.find({ date: { $gte: since } })
    .sort({ date: -1 })
    .lean();

  return snapshots;
}

export async function getInventoryVariance(itemId: string, days = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const snapshots = await InventorySnapshotModel.find({ date: { $gte: since } })
    .sort({ date: 1 })
    .lean();

  const quantities = snapshots.map((s) => ({
    date: s.date,
    quantity: s.items.find((i) => String(i.itemId) === itemId)?.quantity || 0,
  }));

  const changes = [];
  for (let i = 1; i < quantities.length; i++) {
    changes.push({
      date: quantities[i].date,
      change: quantities[i].quantity - quantities[i - 1].quantity,
    });
  }

  const avgUsage = Math.abs(changes.reduce((sum, c) => sum + c.change, 0) / (changes.length || 1));

  return {
    itemId,
    period: { start: since, end: new Date() },
    snapshots: quantities,
    changes,
    averageDailyUsage: round2(avgUsage),
    trend: avgUsage > 0 ? 'decreasing' : 'stable',
  };
}
