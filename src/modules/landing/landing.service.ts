import { LandingModel, LandingDocument, LandingGalleryItem } from './landing.model';
import { writeAuditLog } from '@modules/audit/audit.service';
import { uploadBuffer, deleteResource } from '@providers/cloudinary.provider';
import { config } from '@config/index';
import { AppError } from '@utils/AppError';

interface ActorCtx {
  actorId?: string;
  actorEmail?: string;
  actorRole?: string;
}

async function getOrCreate(): Promise<LandingDocument> {
  let doc = await LandingModel.findOne({ singleton: 'main' });
  if (!doc) doc = await LandingModel.create({ singleton: 'main' });
  return doc;
}

export async function getLandingContent() {
  const doc = await getOrCreate();
  return doc.toObject();
}

export interface UpdateLandingInput {
  hero?: LandingDocument['hero'];
  howItWorks?: LandingDocument['howItWorks'];
  gallery?: Array<Omit<LandingGalleryItem, 'sortOrder' | 'imagePublicId'> & {
    sortOrder?: number;
  }>;
  galleryHashtag?: string;
}

export async function updateLandingContent(patch: UpdateLandingInput, ctx: ActorCtx) {
  const doc = await getOrCreate();
  const before = doc.toObject();

  if (patch.hero !== undefined) doc.hero = patch.hero;
  if (patch.howItWorks !== undefined) doc.howItWorks = patch.howItWorks;
  if (patch.galleryHashtag !== undefined) doc.galleryHashtag = patch.galleryHashtag;

  if (patch.gallery !== undefined) {
    // Replacement semantics — keep imagePublicId from existing item by id when re-saving.
    const existingById = new Map<string, LandingGalleryItem>(
      before.gallery.map((g: LandingGalleryItem) => [g.id, g]),
    );
    doc.gallery = patch.gallery.map((g, idx) => ({
      id: g.id,
      imageUrl: g.imageUrl,
      caption: g.caption,
      sortOrder: g.sortOrder ?? idx,
      imagePublicId: existingById.get(g.id)?.imagePublicId,
    }));
  }

  await doc.save();

  await writeAuditLog({
    ...ctx,
    action: 'landing.update',
    entity: 'LandingContent',
    entityId: String(doc._id),
    before,
    after: doc.toObject(),
  });

  return doc.toObject();
}

export async function uploadGalleryImage(buffer: Buffer, filename: string, ctx: ActorCtx) {
  if (!config.cloudinary.enabled) {
    throw new AppError('SERVICE_UNAVAILABLE', 'Cloudinary not configured');
  }
  const doc = await getOrCreate();

  const id = `gallery-${Date.now()}`;
  const { url, publicId } = await uploadBuffer(buffer, {
    folder: `${config.cloudinary.folder}/landing`,
    publicId: id,
  });

  const item: LandingGalleryItem = {
    id,
    imageUrl: url,
    imagePublicId: publicId,
    sortOrder: doc.gallery.length,
  };
  doc.gallery.push(item);
  await doc.save();

  await writeAuditLog({
    ...ctx,
    action: 'landing.gallery.upload',
    entity: 'LandingContent',
    entityId: String(doc._id),
    metadata: { id, filename },
  });

  return { id: item.id, imageUrl: item.imageUrl };
}

export async function deleteGalleryImage(id: string, ctx: ActorCtx) {
  const doc = await getOrCreate();
  const idx = doc.gallery.findIndex((g) => g.id === id);
  if (idx === -1) throw AppError.notFound('Gallery image not found');
  const removed = doc.gallery[idx];
  doc.gallery.splice(idx, 1);
  await doc.save();

  if (removed.imagePublicId) {
    deleteResource(removed.imagePublicId).catch(() => undefined);
  }

  await writeAuditLog({
    ...ctx,
    action: 'landing.gallery.delete',
    entity: 'LandingContent',
    entityId: String(doc._id),
    metadata: { id },
  });
}
