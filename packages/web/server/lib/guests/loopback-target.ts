import { z } from 'zod';
import type { LoopbackContribution } from '@openchamber/sdk';
import {
  GUEST_LOOPBACK_ENV, GUEST_LOOPBACK_ENV_MAX, GUEST_LOOPBACK_METHODS,
  GUEST_LOOPBACK_PORT_MIN, GUEST_LOOPBACK_PORT_MAX, GUEST_LOOPBACK_ROUTES_MAX,
  canonicalizeLoopbackRoutePath,
} from '@openchamber/sdk';

const portSchema = z.number().int().min(GUEST_LOOPBACK_PORT_MIN).max(GUEST_LOOPBACK_PORT_MAX);
const overrideSchema = z.string().regex(/^[0-9]+$/).transform(Number).pipe(portSchema);
const sortedUnique = (values: readonly string[]): string[] => [...new Set(values)].sort();

export const loopbackGrantScopeSchema = z.object({
  port: portSchema,
  env: z.string().max(GUEST_LOOPBACK_ENV_MAX).regex(GUEST_LOOPBACK_ENV).optional(),
  resolvedPort: portSchema,
  routes: z.array(z.string().refine((route) => {
    const separator = route.indexOf(' ');
    const method = route.slice(0, separator);
    const pathname = route.slice(separator + 1);
    return GUEST_LOOPBACK_METHODS.some((allowed) => allowed === method) && canonicalizeLoopbackRoutePath(pathname) === pathname;
  })).min(1).max(GUEST_LOOPBACK_ROUTES_MAX * GUEST_LOOPBACK_METHODS.length).transform(sortedUnique),
}).strict();

export type LoopbackGrantScope = z.infer<typeof loopbackGrantScopeSchema>;
export type LoopbackTarget = { readonly status: 'ready'; readonly scope: LoopbackGrantScope }
  | { readonly status: 'config-invalid' };

export const resolveLoopbackTarget = (loopback: LoopbackContribution, env: NodeJS.ProcessEnv = process.env): LoopbackTarget => {
  const override = loopback.env === undefined ? undefined : env[loopback.env];
  const resolved = override === undefined || override === ''
    ? { success: true, data: loopback.port }
    : overrideSchema.safeParse(override);
  if (!resolved.success) return { status: 'config-invalid' };
  const scope: LoopbackGrantScope = {
    port: loopback.port,
    resolvedPort: resolved.data,
    routes: sortedUnique(loopback.routes.flatMap((route) => route.methods.map((method) => `${method} ${route.path}`))),
  };
  if (loopback.env !== undefined) scope.env = loopback.env;
  return {
    status: 'ready',
    scope,
  };
};
