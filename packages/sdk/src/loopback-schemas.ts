import { z } from 'zod';
import {
  GUEST_LOOPBACK_BODY_BYTES, GUEST_LOOPBACK_ENV, GUEST_LOOPBACK_ENV_MAX,
  GUEST_LOOPBACK_METHODS, GUEST_LOOPBACK_PATH_MAX, GUEST_LOOPBACK_PORT_MAX,
  GUEST_LOOPBACK_PORT_MIN, GUEST_LOOPBACK_RESPONSE_BYTES, GUEST_LOOPBACK_ROUTES_MAX,
  canonicalizeLoopbackPath, canonicalizeLoopbackRoutePath, isLoopbackQuery, isLoopbackUrlResult,
  type LoopbackContribution, type LoopbackRequest,
} from './loopback.ts';

const pathSchema = z.string().max(GUEST_LOOPBACK_PATH_MAX).transform((value, ctx) => {
  const path = canonicalizeLoopbackPath(value);
  if (path !== null) return path;
  ctx.addIssue({ code: 'custom', message: 'Invalid loopback pathname.' });
  return z.NEVER;
});
const routePathSchema = z.string().max(GUEST_LOOPBACK_PATH_MAX).transform((value, ctx) => {
  const path = canonicalizeLoopbackRoutePath(value);
  if (path !== null) return path;
  ctx.addIssue({ code: 'custom', message: 'Invalid loopback route.' });
  return z.NEVER;
});

export const loopbackContributionSchema = z.object({
  port: z.number().int().min(GUEST_LOOPBACK_PORT_MIN).max(GUEST_LOOPBACK_PORT_MAX),
  env: z.string().max(GUEST_LOOPBACK_ENV_MAX).regex(GUEST_LOOPBACK_ENV).optional(),
  routes: z.array(z.object({
    path: routePathSchema,
    methods: z.array(z.enum(GUEST_LOOPBACK_METHODS)).min(1).max(GUEST_LOOPBACK_METHODS.length)
      .refine((values) => new Set(values).size === values.length),
  }).strict()).min(1).max(GUEST_LOOPBACK_ROUTES_MAX)
    .refine((routes) => new Set(routes.map((route) => route.path)).size === routes.length),
}).strict().transform((value): LoopbackContribution => value);

const querySchema = z.record(z.string(), z.string()).refine(isLoopbackQuery);
export const loopbackUrlRequestSchema = z.object({ path: pathSchema, query: querySchema.optional() }).strict();
export const loopbackRequestSchema = z.discriminatedUnion('method', [
  loopbackUrlRequestSchema.extend({ method: z.enum(['GET', 'HEAD']) }),
  loopbackUrlRequestSchema.extend({
    method: z.literal('POST'),
    body: z.json().refine((value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= GUEST_LOOPBACK_BODY_BYTES).optional(),
  }),
]).transform((value): LoopbackRequest => value);

export const loopbackUrlResultSchema = z.object({
  url: z.string().min(1).max(8192),
  expiresAt: z.number().int().positive(),
}).strict().refine(isLoopbackUrlResult);
export const loopbackRequestResultSchema = z.object({
  status: z.number().int().min(100).max(599),
  body: z.string().max(GUEST_LOOPBACK_RESPONSE_BYTES)
    .refine((value) => new TextEncoder().encode(value).byteLength <= GUEST_LOOPBACK_RESPONSE_BYTES),
}).strict();
