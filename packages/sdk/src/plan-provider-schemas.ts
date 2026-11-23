import { z } from 'zod';
import { GUEST_FILE_PATH_MAX } from './contract.ts';
import { PANEL_ID } from './manifest.ts';
import {
  GUEST_PLAN_ACTIONS_MAX,
  GUEST_PLAN_CONTENT_MAX,
  GUEST_PLAN_ERROR_MAX,
  GUEST_PLAN_PROGRESS_MAX,
  GUEST_PLAN_STATUS_MAX,
  GUEST_PLAN_STATUS_TONES,
  GUEST_PLAN_TITLE_MAX,
  GUEST_PLANS_MAX,
  isGuestPlanPath,
} from './plan-providers.ts';

const planPathSchema = z.string().min(1).max(GUEST_FILE_PATH_MAX).refine(isGuestPlanPath);
const planCountSchema = z.number().int().min(0).max(GUEST_PLAN_PROGRESS_MAX);
const planAnnotationSchema = z.object({
  path: planPathSchema,
  title: z.string().trim().min(1).max(GUEST_PLAN_TITLE_MAX).optional(),
  progress: z.object({ done: planCountSchema, total: planCountSchema }).strict()
    .refine((progress) => progress.done <= progress.total).optional(),
  status: z.object({
    label: z.string().trim().min(1).max(GUEST_PLAN_STATUS_MAX),
    tone: z.enum(GUEST_PLAN_STATUS_TONES).optional(),
  }).strict().optional(),
  actions: z.array(z.string().regex(PANEL_ID).max(64)).max(GUEST_PLAN_ACTIONS_MAX).optional(),
}).strict();

export const planReadResultPayloadSchema = z.object({
  content: z.string().max(GUEST_PLAN_CONTENT_MAX),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
});

export const plansAnnotateRequestSchema = z.object({
  provider: z.string().regex(PANEL_ID).max(64),
  directory: z.string().min(1),
  plans: z.array(z.object({ path: planPathSchema })).max(GUEST_PLANS_MAX),
});

export const plansAnnotateResultPayloadSchema = z.union([
  z.object({ annotations: z.array(planAnnotationSchema).max(GUEST_PLANS_MAX) }).strict(),
  z.object({ error: z.string().trim().min(1).max(GUEST_PLAN_ERROR_MAX) }).strict(),
]);

export const planReadRequestSchema = z.object({
  provider: z.string().regex(PANEL_ID).max(64),
  path: planPathSchema,
}).strict();

export const plansChangedRequestSchema = z.object({
  provider: z.string().regex(PANEL_ID).max(64),
}).strict();
