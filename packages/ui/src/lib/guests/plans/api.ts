import { z } from 'zod';

import {
  GUEST_PLAN_CONTENT_MAX,
  GUEST_PLANS_MAX,
  isGuestPlanPath,
  resolveHostRequestErrorCode,
  type HostRequestErrorCode,
} from '@openchamber/sdk';

import { runtimeFetch } from '@/lib/runtime-fetch';

/**
 * The server side of plan providers: list, read and write the provider's own
 * plan files in one worktree. The worktree travels as `x-opencode-directory`;
 * the server accepts only registered projects and their worktrees.
 */

export type GuestPlanErrorCode = HostRequestErrorCode | 'CONFLICT';

type GuestPlanFailure = {
  ok: false;
  code: GuestPlanErrorCode;
  message: string;
  /** For `CONFLICT`: the hash of the text now on disk, or null when the plan moved. */
  hash?: string | null;
};

type GuestPlanFileEntry = { path: string; size: number; mtime: number };
type GuestPlanListing = { plans: GuestPlanFileEntry[]; truncated: boolean };
type GuestPlanDocument = { content: string; hash: string; mtime: number };
type GuestPlanWriteResult = { hash: string; mtime: number };

type PlanRequestBody =
  | { provider: string }
  | { op: 'read'; provider: string; path: string }
  | { op: 'write'; provider: string; path: string; content: string; expectedHash: string };

type Result<T> = { ok: true; result: T } | GuestPlanFailure;

const hashSchema = z.string().regex(/^[0-9a-f]{64}$/);

const listingSchema = z.object({
  ok: z.literal(true),
  result: z.object({
    plans: z.array(z.object({
      path: z.string().refine(isGuestPlanPath),
      size: z.number().int().min(0),
      mtime: z.number().int().min(0),
    })).max(GUEST_PLANS_MAX),
    truncated: z.boolean(),
  }),
});

const documentSchema = z.object({
  ok: z.literal(true),
  result: z.object({ content: z.string().max(GUEST_PLAN_CONTENT_MAX), hash: hashSchema, mtime: z.number().int().min(0) }),
});

const writeSchema = z.object({
  ok: z.literal(true),
  result: z.object({ hash: hashSchema, mtime: z.number().int().min(0) }),
});

const failureSchema = z.object({
  error: z.string().min(1),
  message: z.string().min(1).optional(),
  hash: hashSchema.nullable().optional(),
});

const failed = (code: GuestPlanErrorCode, message: string): GuestPlanFailure => ({ ok: false, code, message });

const post = async <T>(
  guestId: string,
  route: 'list' | 'file',
  directory: string,
  body: PlanRequestBody,
  schema: z.ZodType<{ ok: true; result: T }>,
): Promise<Result<T>> => {
  let response: Response;
  try {
    response = await runtimeFetch(`/api/guests/${encodeURIComponent(guestId)}/plans/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-opencode-directory': directory },
      body: JSON.stringify(body),
    });
  } catch {
    return failed('HOST_UNAVAILABLE', 'OpenChamber could not be reached.');
  }
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = failureSchema.safeParse(json);
    if (!parsed.success) return failed('HOST_REJECTED', `The server answered ${response.status}.`);
    const code: GuestPlanErrorCode = parsed.data.error === 'CONFLICT' ? 'CONFLICT' : resolveHostRequestErrorCode(parsed.data.error);
    const failure = failed(code, parsed.data.message ?? parsed.data.error);
    if (code === 'CONFLICT') failure.hash = parsed.data.hash ?? null;
    return failure;
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) return failed('HOST_REJECTED', 'The server answered with something this build cannot read.');
  return { ok: true, result: parsed.data.result };
};

export const listGuestPlanFiles = (guestId: string, provider: string, directory: string): Promise<Result<GuestPlanListing>> => (
  post(guestId, 'list', directory, { provider }, listingSchema)
);

export const readGuestPlanFile = (
  guestId: string,
  provider: string,
  directory: string,
  path: string,
): Promise<Result<GuestPlanDocument>> => post(guestId, 'file', directory, { op: 'read', provider, path }, documentSchema);

export const writeGuestPlanFile = (
  guestId: string,
  provider: string,
  directory: string,
  path: string,
  content: string,
  expectedHash: string,
): Promise<Result<GuestPlanWriteResult>> => post(guestId, 'file', directory, { op: 'write', provider, path, content, expectedHash }, writeSchema);
