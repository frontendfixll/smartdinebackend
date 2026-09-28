import { Schema, model, Document, Types } from 'mongoose';

export interface LandingStep {
  num: string;
  name: string;
  body: string;
}

export interface LandingGalleryItem {
  id: string;
  imageUrl: string;
  imagePublicId?: string;
  caption?: string;
  sortOrder: number;
}

export interface LandingHero {
  eyebrow?: string;
  headline?: string;
  body?: string;
}

export interface LandingDocument extends Document {
  _id: Types.ObjectId;
  singleton: 'main';
  hero?: LandingHero;
  howItWorks: LandingStep[];
  gallery: LandingGalleryItem[];
  galleryHashtag?: string;
  createdAt: Date;
  updatedAt: Date;
}

const StepSchema = new Schema<LandingStep>(
  {
    num: { type: String, required: true },
    name: { type: String, required: true },
    body: { type: String, required: true },
  },
  { _id: false },
);

const GalleryItemSchema = new Schema<LandingGalleryItem>(
  {
    id: { type: String, required: true },
    imageUrl: { type: String, required: true },
    imagePublicId: { type: String },
    caption: { type: String },
    sortOrder: { type: Number, default: 0 },
  },
  { _id: false },
);

const HeroSchema = new Schema<LandingHero>(
  {
    eyebrow: { type: String },
    headline: { type: String },
    body: { type: String },
  },
  { _id: false },
);

const LandingSchema = new Schema<LandingDocument>(
  {
    singleton: { type: String, enum: ['main'], default: 'main', unique: true },
    hero: { type: HeroSchema, default: undefined },
    howItWorks: { type: [StepSchema], default: [] },
    gallery: { type: [GalleryItemSchema], default: [] },
    galleryHashtag: { type: String },
  },
  { timestamps: true },
);

export const LandingModel = model<LandingDocument>('LandingContent', LandingSchema);
