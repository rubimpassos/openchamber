import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';
import type { UsageWindow } from '@/types';

/**
 * The limit failover's account list, per-session pin and the provider's
 * preferred account, as the server keeps them. The plugin sweeps each stored
 * Claude account's plan usage and reports the windows it has seen run out;
 * the UI reads both here.
 */

const ROUTE = '/api/openchamber/limit-failover';

/** The account picker and the provider page offer accounts of this provider only. */
export const ACCOUNT_PROVIDER = 'anthropic';

const nullableNumber = z.number().nullable().default(null);
const nullableString = z.string().nullable().default(null);
const windowSchema = z.object({
  usedPercent: nullableNumber,
  remainingPercent: nullableNumber,
  windowSeconds: nullableNumber,
  resetAfterSeconds: nullableNumber,
  resetAt: nullableNumber,
  resetAtFormatted: nullableString,
  resetAfterFormatted: nullableString,
  valueLabel: z.string().nullable().optional(),
}) satisfies z.ZodType<UsageWindow, unknown>;
const usageSchema = z.object({
  windows: z.record(z.string(), windowSchema).optional(),
  models: z.record(z.string(), z.object({ windows: z.record(z.string(), windowSchema).optional() })).optional(),
});

const accountSchema = z.object({
  id: z.string(),
  label: z.string(),
  usage: usageSchema.nullable(),
  exhausted: z.array(z.object({ scope: z.string(), resetAt: z.number() })),
});

const accountsResponseSchema = z.object({
  providerID: z.string(),
  usageAt: z.number().nullable(),
  accounts: z.array(accountSchema),
});

const sessionAccountSchema = z.object({
  sessionID: z.string(),
  providerID: z.string(),
  mode: z.enum(['preferred', 'fixed']),
  credentialID: z.string(),
  updatedAt: z.number(),
});

const providerAccountSchema = z.object({
  providerID: z.string(),
  credentialID: z.string(),
  updatedAt: z.number(),
});

export type LimitAccount = z.infer<typeof accountSchema>;
export type LimitAccountUsage = z.infer<typeof usageSchema>;
type SessionAccountPin = z.infer<typeof sessionAccountSchema>;
export type SessionAccountMode = 'global' | 'preferred' | 'fixed';

/** A window's used percent, or null when the sweep has not seen it. */
export const windowPercent = (usage: LimitAccountUsage | null, window: string): number | null => {
  const percent = usage?.windows?.[window]?.usedPercent;
  return percent != null ? percent : null;
};

/** Per-model weekly windows the sweep reported, as display name and percent. */
export const modelWindows = (usage: LimitAccountUsage | null): { model: string; usedPercent: number }[] => {
  if (!usage?.models) return [];
  return Object.entries(usage.models).flatMap(([model, entry]) => {
    const percent = entry.windows?.['7d']?.usedPercent;
    return percent != null ? [{ model, usedPercent: percent }] : [];
  });
};

const parseBody = async <T>(response: Response, schema: z.ZodType<T>): Promise<T> => {
  if (!response.ok) throw new Error(`Limit failover request failed (${response.status})`);
  return schema.parse(await response.json());
};

/** The provider's accounts with their last swept usage and live exhaustion marks. */
export const fetchLimitAccounts = async (providerId: string): Promise<LimitAccount[]> => {
  const response = await runtimeFetch(`${ROUTE}/accounts?providerID=${encodeURIComponent(providerId)}`);
  return (await parseBody(response, accountsResponseSchema)).accounts;
};

/**
 * The session's pin (null when it follows the global settings) and the
 * account its next request on this provider and model goes out on, when the
 * server knows it.
 */
export const fetchSessionAccount = async (input: {
  sessionId: string;
  providerId: string;
  modelId?: string | null;
}): Promise<{ pin: SessionAccountPin | null; accountId: string | null }> => {
  const query = new URLSearchParams({ sessionID: input.sessionId, providerID: input.providerId });
  if (input.modelId) query.set('modelID', input.modelId);
  const response = await runtimeFetch(`${ROUTE}/session-account?${query.toString()}`);
  const body = await parseBody(response, z.object({ config: sessionAccountSchema.nullable(), account: z.string().nullable().default(null) }));
  return { pin: body.config, accountId: body.account };
};

/** Sets the session's pin. `global` clears it; the others name an account. */
export const setSessionAccount = async (input: {
  sessionId: string;
  providerId: string;
  mode: SessionAccountMode;
  credentialId?: string;
}): Promise<SessionAccountPin | null> => {
  const response = await runtimeFetch(`${ROUTE}/session-account`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionID: input.sessionId,
      providerID: input.providerId,
      mode: input.mode,
      credentialID: input.credentialId,
    }),
  });
  return (await parseBody(response, z.object({ config: sessionAccountSchema.nullable() }))).config;
};

/** The account the provider's global "preferred" mode returns to, or null. */
export const fetchPreferredAccount = async (providerId: string): Promise<string | null> => {
  const response = await runtimeFetch(`${ROUTE}/provider-account?providerID=${encodeURIComponent(providerId)}`);
  return (await parseBody(response, z.object({ config: providerAccountSchema.nullable() }))).config?.credentialID ?? null;
};

/** Sets the provider's preferred account; null clears it. */
export const setPreferredAccount = async (providerId: string, credentialId: string | null): Promise<void> => {
  const response = await runtimeFetch(`${ROUTE}/provider-account`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ providerID: providerId, credentialID: credentialId }),
  });
  await parseBody(response, z.object({ config: providerAccountSchema.nullable() }));
};
