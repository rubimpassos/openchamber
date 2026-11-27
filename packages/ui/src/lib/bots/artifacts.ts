import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { isVSCodeRuntime } from '@/lib/desktop';
import { getBotsRuntime } from '../botsRuntime';
import { BotsApiError } from '../botsApi';

const text = z.string().min(1).max(200);
const producer = z.discriminatedUnion('role', [
  z.object({ role: z.literal('stage'), stage: z.enum(['investigation', 'fixing', 'judge']) }).strict(),
  z.object({ role: z.literal('conversation') }).strict(),
]);
const missingAsset = z.object({
  source: z.string().min(1).max(4096), status: z.enum(['missing', 'rejected', 'too-heavy', 'external']),
}).strict();
const artifactId = z.string().regex(/^artifact_[a-f0-9]{64}$/);
const botArtifactSchema = z.object({
  id: artifactId, title: z.string().min(1).max(120), kind: z.enum(['evidence', 'decision']),
  requirement: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
  createdAt: z.number().int().nonnegative(),
   source: z.object({ sessionId: text, callId: text, producer, messageId: text.optional() }).strict(),
  interaction: z.enum(['none', 'awaitAnswer', 'answerLater', 'share']),
  incompleteAssets: z.array(missingAsset).max(256),
}).strict();
export const botArtifactReferenceSchema = botArtifactSchema.extend({ publication: z.enum(['captured', 'published']) }).strict();
export const botArtifactListSchema = z.object({
  artifacts: z.array(botArtifactSchema).max(100), nextOffset: z.number().int().nonnegative().nullable(),
}).strict();
const botArtifactPageProjectionSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('answered'), summary: z.string(), data: z.json(), undelivered: z.literal(true).optional() }).strict(),
    z.object({ kind: z.literal('waiting'), later: z.literal(true).optional() }).strict(),
    z.object({ kind: z.enum(['declined', 'not-drawn']), undelivered: z.literal(true).optional() }).strict(),
    z.object({ kind: z.enum(['show', 'unanswered', 'answered-in-chat', 'chat-sent-earlier', 'later']) }).strict(),
  ]);
const artifactContentSchema = z.object({
  artifact: botArtifactSchema,
  payload: z.object({
    version: z.literal(1),
    body: z.discriminatedUnion('format', [
      z.object({ format: z.literal('html'), content: z.string().min(1).max(200_000) }).strict(),
      z.object({ format: z.literal('ui'), content: z.string().min(1).max(200_000) }).strict(),
    ]),
    assets: z.array(z.discriminatedUnion('status', [
      z.object({ source: z.string().min(1).max(4096), status: z.literal('ready'),
        mime: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
        data: z.string().max(Math.ceil(10 * 1024 * 1024 / 3) * 4).regex(/^[A-Za-z0-9+/]*={0,2}$/).refine((value) => value.length % 4 === 0) }).strict(),
      missingAsset,
    ])).max(256),
  }).strict(),
}).strict();
export const botArtifactReadSchema = z.union([
  artifactContentSchema.extend({ page: botArtifactPageProjectionSchema.nullable().optional(), pageError: z.undefined().optional() }).strict(),
  artifactContentSchema.extend({ page: z.undefined().optional(), pageError: z.literal('BOT_ARTIFACT_PAGE_UNAVAILABLE') }).strict(),
]);
export type BotArtifact = z.output<typeof botArtifactSchema>;
export type BotArtifactRead = z.output<typeof botArtifactReadSchema>;
export type BotArtifactReference = z.output<typeof botArtifactReferenceSchema>;
type BotArtifactScope = { readonly projectId: string; readonly itemId: string };
export type BotArtifactFailure = 'network' | 'unavailable' | 'failed';
const UNREACHABLE = 'BOT_ARTIFACT_UNREACHABLE';
export function botArtifactFailure(error: BotsApiError): BotArtifactFailure {
  if (error.code === UNREACHABLE) return 'network';
  return error.status === 503 ? 'unavailable' : 'failed';
}
const root = ({ projectId, itemId }: BotArtifactScope) =>
  `/api/projects/${encodeURIComponent(projectId)}/bots/items/${encodeURIComponent(itemId)}/artifacts`;

async function request<Value>(url: string, schema: z.ZodType<Value>, signal?: AbortSignal): Promise<Value> {
  if (isVSCodeRuntime()) throw new BotsApiError(501, 'bots_unsupported');
  const runtime = getBotsRuntime();
  const activeSignal = signal ? AbortSignal.any([runtime.signal, signal]) : runtime.signal;
  let response: Response;
  try {
    response = await runtimeFetch(url, { signal: activeSignal });
  } catch (cause) {
    if (activeSignal.aborted) throw cause;
    throw new BotsApiError(0, UNREACHABLE);
  }
  if (!response.ok) throw new BotsApiError(response.status, 'BOT_ARTIFACT_READ_FAILED');
  const parsed = schema.parse(await response.json());
  activeSignal.throwIfAborted();
  return parsed;
}
export const fetchBotArtifacts = (scope: BotArtifactScope, options: { readonly offset?: number; readonly signal?: AbortSignal } = {}) => {
  const offset = z.number().int().nonnegative().max(4096).parse(options.offset ?? 0);
  return request(`${root(scope)}?offset=${offset}`, botArtifactListSchema, options.signal);
};
export const fetchBotArtifact = (scope: BotArtifactScope, id: string, signal?: AbortSignal) =>
  request(`${root(scope)}/${encodeURIComponent(artifactId.parse(id))}`, botArtifactReadSchema, signal);
