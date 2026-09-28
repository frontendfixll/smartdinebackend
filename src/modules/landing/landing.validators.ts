import { z } from 'zod';

const stepSchema = z.object({
  num: z.string().min(1).max(8),
  name: z.string().min(1).max(120),
  body: z.string().min(1).max(800),
});

const heroSchema = z.object({
  eyebrow: z.string().max(120).optional(),
  headline: z.string().max(200).optional(),
  body: z.string().max(600).optional(),
});

const galleryItemSchema = z.object({
  id: z.string().min(1).max(120),
  imageUrl: z.string().url(),
  caption: z.string().max(200).optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});

export const updateLandingSchema = z
  .object({
    hero: heroSchema.optional(),
    howItWorks: z.array(stepSchema).max(10).optional(),
    gallery: z.array(galleryItemSchema).max(60).optional(),
    galleryHashtag: z.string().max(80).optional(),
  })
  .strict();

export const galleryItemIdParamSchema = z.object({
  id: z.string().min(1).max(120),
});
