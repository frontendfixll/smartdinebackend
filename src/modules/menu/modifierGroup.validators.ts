import { z } from 'zod';
import { mongoId } from '@utils/zod';

import { pizzaArtwork } from './pizza';

const modifierSchema = z.object({
  name: z.string().min(1).max(60),
  pizzaArt: z.enum(pizzaArtwork).nullable().optional(),
  priceDelta: z.number().optional(),
  isDefault: z.boolean().optional(),
  is86: z.boolean().optional(),
});

export const createModifierGroupSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(300).optional(),
  isRequired: z.boolean(),
  minSelections: z.number().int().min(0),
  maxSelections: z.number().int().min(1),
  modifiers: z.array(modifierSchema).min(1).max(40),
});

export const updateModifierGroupSchema = z
  .object({
    name: z.string().min(1).max(80),
    description: z.string().max(300),
    isRequired: z.boolean(),
    minSelections: z.number().int().min(0),
    maxSelections: z.number().int().min(1),
    modifiers: z.array(modifierSchema.extend({ _id: mongoId().optional() })).min(1).max(40),
    isActive: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field' });

export const idParamSchema = z.object({ id: mongoId() });
