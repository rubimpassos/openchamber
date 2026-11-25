import { z } from 'zod';
import { renderedPageProjectionSchema } from '../openchamber-control/page-projection.js';
import { conversationDeliverySchema } from '../bots/conversation-delivery.js';
import {
  BOT_ARTIFACT_CHUNK_BYTES, artifactBindingSchema, artifactDigestSchema, artifactIdSchema, artifactManifestSchema,
} from '../bots/artifacts-contract.js';

export const BOT_ARTIFACT_AGENT_ROUTE = '/api/openchamber/bot-services/artifacts';
export const BOT_ARTIFACT_SPACE_ROUTE = '/api/openchamber/bots/artifacts';
export const BOT_ARTIFACT_REPLY_BYTES = 2 * 1024 * 1024;
export const BOT_ARTIFACT_TIMEOUT_MS = 30_000;
const count = z.number().int().nonnegative().max(4096);
export const artifactPullInputSchema = z.object({ binding: artifactBindingSchema, offset: count.default(0) }).strict();
export const artifactPullReplySchema = z.object({
  entries: z.array(artifactManifestSchema).max(1), nextOffset: count.nullable(),
}).strict();
export const artifactChunkInputSchema = z.object({
  binding: artifactBindingSchema, id: artifactIdSchema, callId: z.string().min(1).max(200),
  offset: z.number().int().nonnegative().max(40 * 1024 * 1024),
}).strict();
export const artifactChunkReplySchema = z.object({
  id: artifactIdSchema, payloadDigest: artifactDigestSchema, offset: z.number().int().nonnegative(),
  data: z.string().min(1).max(Math.ceil(BOT_ARTIFACT_CHUNK_BYTES / 3) * 4)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/).refine((value) => value.length % 4 === 0),
}).strict();
export type BotArtifactPullInput = z.output<typeof artifactPullInputSchema>;
export type BotArtifactChunkInput = z.output<typeof artifactChunkInputSchema>;
export const artifactPageInputSchema = artifactChunkInputSchema.omit({ callId: true, offset: true }).strict();
export const artifactPageReplySchema = z.object({ page: renderedPageProjectionSchema.nullable() }).strict();
export const artifactDeliveryReplySchema = z.object({ entries: z.array(conversationDeliverySchema).max(1), nextOffset: count.nullable() }).strict();
export const artifactDeliverySettleSchema = z.object({ binding: artifactBindingSchema, id: z.string().min(1).max(200) }).strict();
export const artifactProducerInputSchema = z.object({ binding: artifactBindingSchema }).strict();
export interface BotArtifactTransport {
  pull(input: BotArtifactPullInput, signal?: AbortSignal): Promise<z.output<typeof artifactPullReplySchema>>;
  chunk(input: BotArtifactChunkInput, signal?: AbortSignal): Promise<z.output<typeof artifactChunkReplySchema>>;
  page(input: z.output<typeof artifactPageInputSchema>, signal?: AbortSignal): Promise<z.output<typeof artifactPageReplySchema>>;
  deliveries(input: BotArtifactPullInput, signal?: AbortSignal): Promise<z.output<typeof artifactDeliveryReplySchema>>;
  settleDelivery(input: z.output<typeof artifactDeliverySettleSchema>, signal?: AbortSignal): Promise<{ readonly settled: true }>;
  quiesce(input: z.output<typeof artifactProducerInputSchema>, signal?: AbortSignal): Promise<{ readonly stopped: true }>;
  drain(input: z.output<typeof artifactProducerInputSchema>, signal?: AbortSignal): Promise<{ readonly drained: true }>;
}
