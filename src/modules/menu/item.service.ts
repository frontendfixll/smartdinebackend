import { Types, FilterQuery } from 'mongoose';
import { ItemModel, ItemDocument } from './item.model';
import { CategoryModel } from './category.model';
import { ModifierGroupModel } from './modifierGroup.model';
import { AppError } from '@utils/AppError';
import { toSlug } from '@utils/zod';
import { writeAuditLog } from '@modules/audit/audit.service';
import { emitMenuEvent } from './events';
import { uploadBuffer, deleteResource } from '@providers/cloudinary.provider';
import { config } from '@config/index';

interface ActorCtx {
  actorId?: string;
  actorEmail?: string;
  actorRole?: string;
}

async function ensureUniqueSlug(base: string, excludeId?: string): Promise<string> {
  let slug = base;
  let i = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const existing = await ItemModel.findOne({ slug }).select('_id').lean();
    if (!existing || String(existing._id) === excludeId) return slug;
    slug = `${base}-${++i}`;
  }
}

async function ensureCategoryExists(categoryId: string) {
  const c = await CategoryModel.findById(categoryId).select('_id').lean();
  if (!c) throw AppError.badRequest('categoryId not found');
}

async function ensureModifierGroupsExist(ids: string[]) {
  if (!ids.length) return;
  const count = await ModifierGroupModel.countDocuments({ _id: { $in: ids } });
  if (count !== ids.length) throw AppError.badRequest('One or more modifierGroupIds not found');
}

export interface CreateItemInput {
  name: string;
  slug?: string;
  description?: string;
  categoryId: string;
  basePrice: number;
  imageUrl?: string;
  pizzaBuilder?: import('./pizza').PizzaBuilder | null;
  prepTimeMinutes?: number;
  foodType: 'veg' | 'non_veg' | 'egg' | 'vegan';
  spiceLevel?: number;
  calories?: number;
  allergens?: string[];
  hsnCode?: string;
  variants?: Array<{ _id?: string; name: string; priceDelta?: number; absolutePrice?: number; sku?: string }>;
  modifierGroupIds?: string[];
  availabilityWindows?: Array<{ daysOfWeek: number[]; startTime: string; endTime: string }>;
  station?: string;
  tags?: string[];
  translations?: Record<string, { name: string; description?: string }>;
  sortOrder?: number;
}

export async function createItem(input: CreateItemInput, ctx: ActorCtx) {
  await ensureCategoryExists(input.categoryId);
  if (input.modifierGroupIds) await ensureModifierGroupsExist(input.modifierGroupIds);

  const baseSlug = input.slug ? toSlug(input.slug) : toSlug(input.name);
  const slug = await ensureUniqueSlug(baseSlug);

  const item = await ItemModel.create({
    name: input.name,
    slug,
    description: input.description,
    categoryId: new Types.ObjectId(input.categoryId),
    basePrice: input.basePrice,
    pizzaBuilder: input.pizzaBuilder,
    imageUrl: input.imageUrl || undefined,
    prepTimeMinutes: input.prepTimeMinutes ?? 10,
    foodType: input.foodType,
    spiceLevel: input.spiceLevel ?? 0,
    calories: input.calories,
    allergens: input.allergens ?? [],
    hsnCode: input.hsnCode,
    variants: input.variants ?? [],
    modifierGroupIds: input.modifierGroupIds?.map((id) => new Types.ObjectId(id)) ?? [],
    availabilityWindows: input.availabilityWindows ?? [],
    station: input.station,
    tags: input.tags ?? [],
    translations: input.translations,
    sortOrder: input.sortOrder ?? 0,
  });

  await writeAuditLog({
    ...ctx,
    action: 'item.create',
    entity: 'Item',
    entityId: String(item._id),
    after: item.toObject(),
  });
  emitMenuEvent('item:updated', { id: String(item._id), action: 'create' });
  return item.toObject();
}

export interface ListItemsOptions {
  q?: string;
  categoryId?: string;
  foodType?: 'veg' | 'non_veg' | 'egg' | 'vegan';
  is86?: boolean;
  isActive?: boolean;
  station?: string;
  page?: number;
  limit?: number;
}

export async function listItems(opts: ListItemsOptions) {
  const page = Math.max(1, opts.page ?? 1);
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  const filter: FilterQuery<ItemDocument> = {};
  if (opts.categoryId) filter.categoryId = new Types.ObjectId(opts.categoryId);
  if (opts.foodType) filter.foodType = opts.foodType;
  if (typeof opts.is86 === 'boolean') filter.is86 = opts.is86;
  if (typeof opts.isActive === 'boolean') filter.isActive = opts.isActive;
  if (opts.station) filter.station = opts.station;
  if (opts.q) {
    const rx = new RegExp(opts.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ name: rx }, { description: rx }, { tags: rx }];
  }
  const [items, total] = await Promise.all([
    ItemModel.find(filter).sort({ sortOrder: 1, name: 1 }).skip((page - 1) * limit).limit(limit).lean(),
    ItemModel.countDocuments(filter),
  ]);
  return { items, meta: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 } };
}

export async function getItem(id: string) {
  const item = await ItemModel.findById(id).lean();
  if (!item) throw AppError.notFound('Item not found');
  return item;
}

export interface UpdateItemInput extends Partial<CreateItemInput> {
  isActive?: boolean;
}

export async function updateItem(id: string, input: UpdateItemInput, ctx: ActorCtx) {
  const item = await ItemModel.findById(id);
  if (!item) throw AppError.notFound('Item not found');
  const before = item.toObject();

  if (input.categoryId) {
    await ensureCategoryExists(input.categoryId);
    item.categoryId = new Types.ObjectId(input.categoryId);
  }
  if (input.modifierGroupIds) {
    await ensureModifierGroupsExist(input.modifierGroupIds);
    item.modifierGroupIds = input.modifierGroupIds.map((id) => new Types.ObjectId(id));
  }
  if (input.slug !== undefined) item.slug = await ensureUniqueSlug(toSlug(input.slug), id);
  if (input.name !== undefined) item.name = input.name;
  if (input.description !== undefined) item.description = input.description;
  if (input.basePrice !== undefined) item.basePrice = input.basePrice;
  if (input.pizzaBuilder !== undefined) item.pizzaBuilder = input.pizzaBuilder;
  if (input.imageUrl !== undefined) item.imageUrl = input.imageUrl || undefined;
  if (input.prepTimeMinutes !== undefined) item.prepTimeMinutes = input.prepTimeMinutes;
  if (input.foodType !== undefined) item.foodType = input.foodType;
  if (input.spiceLevel !== undefined) item.spiceLevel = input.spiceLevel;
  if (input.calories !== undefined) item.calories = input.calories;
  if (input.allergens !== undefined) item.allergens = input.allergens;
  if (input.hsnCode !== undefined) item.hsnCode = input.hsnCode;
  if (input.variants !== undefined) {
    const used = new Set<string>();
    const variants = input.variants.map((v) => {
      if (!v._id) return v;
      const existing = item.variants.find((candidate) => String(candidate._id) === v._id);
      if (!existing || used.has(v._id)) throw AppError.badRequest('Invalid or duplicate size ID');
      used.add(v._id);
      return { ...v, is86: existing.is86, sku: v.sku ?? existing.sku };
    });
    item.set('variants', variants);
  }
  if (input.availabilityWindows !== undefined) item.set('availabilityWindows', input.availabilityWindows);
  if (input.station !== undefined) item.station = input.station;
  if (input.tags !== undefined) item.tags = input.tags;
  if (input.translations !== undefined) item.translations = new Map(Object.entries(input.translations));
  if (input.sortOrder !== undefined) item.sortOrder = input.sortOrder;
  if (typeof input.isActive === 'boolean') item.isActive = input.isActive;

  await item.save();

  await writeAuditLog({
    ...ctx,
    action: 'item.update',
    entity: 'Item',
    entityId: String(item._id),
    before,
    after: item.toObject(),
  });
  emitMenuEvent('item:updated', { id: String(item._id), action: 'update' });
  return item.toObject();
}

export async function toggle86(id: string, is86: boolean, ctx: ActorCtx) {
  const item = await ItemModel.findById(id);
  if (!item) throw AppError.notFound('Item not found');
  item.is86 = is86;
  await item.save();
  await writeAuditLog({
    ...ctx,
    action: 'item.86',
    entity: 'Item',
    entityId: String(item._id),
    metadata: { is86 },
  });
  emitMenuEvent('item:86_changed', { id: String(item._id), is86 });
  return item.toObject();
}

export async function uploadItemImage(
  id: string,
  buffer: Buffer,
  filename: string,
  ctx: ActorCtx,
  contentType = 'image/jpeg',
) {
  const item = await ItemModel.findById(id);
  if (!item) throw AppError.notFound('Item not found');
  const previousPublicId = item.imagePublicId;

  let url: string;
  let publicId: string;
  if (config.cloudinary.enabled) {
    ({ url, publicId } = await uploadBuffer(buffer, {
      folder: `${config.cloudinary.folder}/items`,
      publicId: `${item.slug}-${Date.now()}`,
    }));
  } else {
    // No Cloudinary — store in GridFS (this DB) and serve via a public endpoint.
    const { storeImage } = await import('./imageStore');
    const fileId = await storeImage(buffer, filename, contentType);
    publicId = `gridfs:${fileId}`;
    url = `${config.urls.publicBase}${config.apiPrefix}/items/image/${fileId}`;
  }

  item.imageUrl = url;
  item.imagePublicId = publicId;
  await item.save();

  if (previousPublicId && previousPublicId !== publicId) {
    if (previousPublicId.startsWith('gridfs:')) {
      const { deleteImage } = await import('./imageStore');
      deleteImage(previousPublicId.slice('gridfs:'.length)).catch(() => undefined);
    } else {
      deleteResource(previousPublicId).catch(() => undefined);
    }
  }

  await writeAuditLog({
    ...ctx,
    action: 'item.image.upload',
    entity: 'Item',
    entityId: String(item._id),
    metadata: { filename, publicId },
  });
  emitMenuEvent('item:updated', { id: String(item._id), action: 'image' });
  return { imageUrl: url, imagePublicId: publicId };
}

/** Public: stream a GridFS-stored item image. */
export async function serveItemImage(fileId: string, res: import('express').Response) {
  const { streamImage } = await import('./imageStore');
  await streamImage(fileId, res);
}

export async function deleteItem(id: string, ctx: ActorCtx) {
  const item = await ItemModel.findById(id);
  if (!item) throw AppError.notFound('Item not found');
  await ItemModel.deleteOne({ _id: item._id });
  if (item.imagePublicId) deleteResource(item.imagePublicId).catch(() => undefined);
  await writeAuditLog({
    ...ctx,
    action: 'item.delete',
    entity: 'Item',
    entityId: String(item._id),
    before: item.toObject(),
  });
  emitMenuEvent('item:updated', { id: String(item._id), action: 'delete' });
}

export async function bulkUpdatePrices(updates: Array<{ id: string; basePrice: number }>, ctx: ActorCtx) {
  const ops = updates.map((u) => ({
    updateOne: {
      filter: { _id: new Types.ObjectId(u.id) },
      update: { $set: { basePrice: u.basePrice } },
    },
  }));
  if (!ops.length) return { matched: 0, modified: 0 };
  const res = await ItemModel.bulkWrite(ops);
  await writeAuditLog({
    ...ctx,
    action: 'item.bulk_price_update',
    entity: 'Item',
    metadata: { count: updates.length, sample: updates.slice(0, 5) },
  });
  emitMenuEvent('menu:updated', { action: 'bulk_price' });
  return { matched: res.matchedCount, modified: res.modifiedCount };
}
