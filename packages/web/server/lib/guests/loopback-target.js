import { z } from 'zod';
import {
  GUEST_LOOPBACK_ENV, GUEST_LOOPBACK_ENV_MAX, GUEST_LOOPBACK_METHODS,
  GUEST_LOOPBACK_PORT_MIN, GUEST_LOOPBACK_PORT_MAX, GUEST_LOOPBACK_ROUTES_MAX,
  canonicalizeLoopbackRoutePath,
} from '@openchamber/sdk';

const portSchema = z.number().int().min(GUEST_LOOPBACK_PORT_MIN).max(GUEST_LOOPBACK_PORT_MAX);
const overrideSchema = z.string().regex(/^[0-9]+$/).transform(Number).pipe(portSchema);
const sortedUnique = (values) => [...new Set(values)].sort();

/** Persisted approval, never an environment value or a request-selected target. */
export const loopbackGrantScopeSchema = z.object({
  port: portSchema,
  env: z.string().max(GUEST_LOOPBACK_ENV_MAX).regex(GUEST_LOOPBACK_ENV).optional(),
  resolvedPort: portSchema,
  routes: z.array(z.string().refine((route) => {
    const separator = route.indexOf(' ');
    const method = route.slice(0, separator);
    const pathname = route.slice(separator + 1);
    return GUEST_LOOPBACK_METHODS.includes(method) && canonicalizeLoopbackRoutePath(pathname) === pathname;
  })).min(1).max(GUEST_LOOPBACK_ROUTES_MAX * GUEST_LOOPBACK_METHODS.length).transform(sortedUnique),
}).strict();

/** @typedef {z.infer<typeof loopbackGrantScopeSchema>} LoopbackGrantScope */
/** @typedef {{ status: 'ready', scope: LoopbackGrantScope } | { status: 'config-invalid' }} LoopbackTarget */

/**
 * Resolve at use time, outside the catalog cache. Approval and routing must
 * use this same result; invalid overrides never fall back or expose raw env.
 * @param {import('@openchamber/sdk').LoopbackContribution} loopback Parsed declaration.
 * @param {NodeJS.ProcessEnv} env Server environment, injectable for tests.
 * @returns {LoopbackTarget}
 */
export const resolveLoopbackTarget = (loopback, env = process.env) => {
  const override = loopback.env === undefined ? undefined : env[loopback.env];
  const resolved = override === undefined || override === ''
    ? { success: true, data: loopback.port }
    : overrideSchema.safeParse(override);
  if (!resolved.success) return { status: 'config-invalid' };
  return {
    status: 'ready',
    scope: {
      port: loopback.port,
      ...(loopback.env === undefined ? {} : { env: loopback.env }),
      resolvedPort: resolved.data,
      routes: sortedUnique(loopback.routes.flatMap((route) => route.methods.map((method) => `${method} ${route.path}`))),
    },
  };
};
