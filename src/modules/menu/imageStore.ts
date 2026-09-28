import mongoose from 'mongoose';
import type { Response } from 'express';

// Use the mongodb driver bundled with mongoose so the Db type matches connection.db.
const { GridFSBucket, ObjectId } = mongoose.mongo;

// In-app image storage using MongoDB GridFS — no external service required and it
// persists in the same database (works locally and on Atlas in production).
function bucket() {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Database not connected');
  return new GridFSBucket(db, { bucketName: 'itemImages' });
}

/** Store an image buffer, returning the GridFS file id as a string. */
export function storeImage(
  buffer: Buffer,
  filename: string,
  contentType: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const upload = bucket().openUploadStream(filename, { contentType });
    upload.on('error', reject);
    upload.on('finish', () => resolve(String(upload.id)));
    upload.end(buffer);
  });
}

/** Stream a stored image to the HTTP response, or 404 if missing. */
export async function streamImage(fileId: string, res: Response): Promise<void> {
  let _id: InstanceType<typeof ObjectId>;
  try {
    _id = new ObjectId(fileId);
  } catch {
    res.status(404).end();
    return;
  }
  const b = bucket();
  const files = await b.find({ _id }).limit(1).toArray();
  if (!files.length) {
    res.status(404).end();
    return;
  }
  res.setHeader('Content-Type', files[0].contentType || 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  b.openDownloadStream(_id)
    .on('error', () => {
      if (!res.headersSent) res.status(404).end();
    })
    .pipe(res);
}

/** Best-effort delete of a stored image (used when replacing). */
export async function deleteImage(fileId: string): Promise<void> {
  try {
    await bucket().delete(new ObjectId(fileId));
  } catch {
    /* already gone or invalid id — ignore */
  }
}
