import mongoose, { Types } from 'mongoose';
import { OrderModel } from '@modules/orders/order.model';
import { InventoryItemModel } from './inventoryItem.model';
import { StockMovementModel } from './stockMovement.model';
import { RecipeModel } from './recipe.model';
import { convert } from './units';
import { getIo } from '@sockets/index';
import { AppError } from '@utils/AppError';
import { AuditLogModel } from '@modules/audit/auditLog.model';

/** Stock, movement history and completion marker commit together. Requires a replica set. */
export async function deductOrderInventory(orderId: Types.ObjectId | string) {
  const result = await mongoose.connection.transaction(async (session) => {
    const order = await OrderModel.findById(orderId).session(session);
    if (!order || order.inventoryDeductedAt)
      return {
        processed: 0,
        skipped: 0,
        alerts: [] as Array<{
          id: string;
          name: string;
          currentStock: number;
          threshold: number;
          unit: string;
        }>,
      };
    if (order.status !== 'settled') throw AppError.conflict('Only settled orders can be deducted');
    if (
      await StockMovementModel.exists({ orderId: order._id, type: 'recipe_deduction' }).session(
        session,
      )
    ) {
      throw AppError.conflict(
        'Legacy inventory movements require reconciliation before automatic deduction',
      );
    }
    // The marker write serializes two deductions for this same order.
    order.inventoryDeductedAt = new Date();
    await order.save({ session });
    let processed = 0,
      skipped = 0;
    const alerts: Array<{
      id: string;
      name: string;
      currentStock: number;
      threshold: number;
      unit: string;
    }> = [];
    const recipeItems = order.items.flatMap((item) => {
      if (item.status === 'cancelled') return [];
      if (item.comboId) {
        if (!item.comboComponents?.length)
          throw AppError.conflict('Legacy combo requires ingredient reconciliation');
        return item.comboComponents.map((component) => ({
          itemId: component.itemId,
          variantId: component.variantId,
          qty: item.qty * component.qty,
          name: item.name,
        }));
      }
      return [{ itemId: item.itemId, variantId: item.variantId, qty: item.qty, name: item.name }];
    });
    for (const item of recipeItems) {
      if (!item.itemId) {
        skipped++;
        continue;
      }
      const specific = item.variantId
        ? await RecipeModel.findOne({
            itemId: item.itemId,
            variantId: item.variantId,
            isActive: true,
          }).session(session)
        : null;
      const recipe =
        specific ??
        (await RecipeModel.findOne({
          itemId: item.itemId,
          variantId: null,
          isActive: true,
        }).session(session));
      if (!recipe) {
        skipped++;
        continue;
      }
      for (const ingredient of recipe.ingredients) {
        const current = await InventoryItemModel.findById(ingredient.inventoryItemId).session(
          session,
        );
        if (!current)
          throw AppError.conflict('Recipe ingredient no longer exists; repair recipe before retry');
        const qty =
          Math.round(convert(ingredient.qty * item.qty, ingredient.unit, current.unit) * 1000) /
          1000;
        const inventory = await InventoryItemModel.findOneAndUpdate(
          { _id: current._id },
          { $inc: { currentStock: -qty } },
          { new: true, session },
        );
        if (!inventory) throw AppError.conflict('Ingredient was removed');
        await StockMovementModel.create(
          [
            {
              inventoryItemId: inventory._id,
              type: 'recipe_deduction',
              qty: -qty,
              unit: inventory.unit,
              reason: `Order ${order.orderNumber} — ${item.name}`,
              orderId: order._id,
              resultingStock: inventory.currentStock,
            },
          ],
          { session },
        );
        if (inventory.currentStock <= inventory.lowStockThreshold)
          alerts.push({
            id: String(inventory._id),
            name: inventory.name,
            currentStock: inventory.currentStock,
            threshold: inventory.lowStockThreshold,
            unit: inventory.unit,
          });
        processed++;
      }
    }
    await AuditLogModel.create(
      [
        {
          action: 'inventory.deduct.order',
          entity: 'Order',
          entityId: String(order._id),
          at: new Date(),
          metadata: { processed, skipped },
        },
      ],
      { session },
    );
    return { processed, skipped, alerts };
  });
  for (const alert of result.alerts) {
    try {
      getIo().of('/staff').emit('inventory:low_stock', alert);
    } catch {
      /* polling remains authoritative */
    }
  }
  return { processed: result.processed, skipped: result.skipped, alerts: result.alerts.length };
}
