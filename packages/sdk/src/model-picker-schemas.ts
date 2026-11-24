import { z } from 'zod';
import { GUEST_MODEL_ID, GUEST_MODEL_PICK_LABEL_MAX } from './model-picker.ts';
import { guestPopoverAnchorSchema } from './popover-schemas.ts';

export const modelPickRequestSchema = z.object({
  anchor: guestPopoverAnchorSchema,
  value: z.string().regex(GUEST_MODEL_ID).nullable(),
  none: z.object({ label: z.string().min(1).max(GUEST_MODEL_PICK_LABEL_MAX) }).strict().optional(),
  recommended: z.string().regex(GUEST_MODEL_ID).optional(),
}).strict();

export const modelPickResultSchema = z.discriminatedUnion('picked', [
  z.object({ picked: z.literal(true), model: z.string().regex(GUEST_MODEL_ID).nullable() }).strict(),
  z.object({ picked: z.literal(false) }).strict(),
]);

export const guestModelCatalogSchema = z.array(z.object({
  id: z.string().regex(GUEST_MODEL_ID),
  name: z.string(),
  provider: z.string().optional(),
  variants: z.array(z.string().min(1)).readonly(),
}).strict().readonly()).readonly();
