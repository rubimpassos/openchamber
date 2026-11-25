import { createHash } from 'node:crypto';
import { z } from 'zod';

export const BOT_ARTIFACT_SOURCE_LENGTH = 200_000;
export const BOT_ARTIFACT_IMAGE_BYTES = 10 * 1024 * 1024;
export const BOT_ARTIFACT_ASSET_BYTES = 25 * 1024 * 1024;
export const BOT_ARTIFACT_PAYLOAD_BYTES = 40 * 1024 * 1024;
export const BOT_ARTIFACT_CATALOG_BYTES = 4 * 1024 * 1024;
export const BOT_ARTIFACT_CHUNK_BYTES = 256 * 1024;
export const artifactText = z.string().min(1).max(200).refine((value) =>
  ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127));
export const artifactDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const artifactIdSchema = z.string().regex(/^artifact_[a-f0-9]{64}$/);
export const artifactCallSchema = z.object({ sessionId: artifactText, callId: artifactText }).strict();
const roleSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('stage'), stage: z.enum(['investigation', 'fixing', 'judge']) }).strict(),
  z.object({ role: z.literal('conversation') }).strict(),
]);
export const artifactBindingSchema = z.object({
  projectId: artifactText, botId: artifactText, itemId: artifactText, sessionId: artifactText,
  directory: z.string().min(1).max(4096), producer: roleSchema,
}).strict();
export const artifactBodySchema = z.discriminatedUnion('format', [
  z.object({ format: z.literal('html'), content: z.string().min(1).max(BOT_ARTIFACT_SOURCE_LENGTH) }).strict(),
  z.object({ format: z.literal('ui'), content: z.string().min(1).max(BOT_ARTIFACT_SOURCE_LENGTH) }).strict(),
]);
export const artifactKindSchema = z.enum(['evidence', 'decision']);
export const artifactInteractionSchema = z.enum(['none', 'awaitAnswer', 'answerLater', 'share']);
const assetSource = z.string().min(1).max(4096);
export const artifactMissingAssetSchema = z.object({
  source: assetSource, status: z.enum(['missing', 'rejected', 'too-heavy', 'external']),
}).strict();
export const artifactAssetSchema = z.discriminatedUnion('status', [
  z.object({ source: assetSource, status: z.literal('ready'), mime: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
    data: z.string().max(Math.ceil(BOT_ARTIFACT_IMAGE_BYTES / 3) * 4).regex(/^[A-Za-z0-9+/]*={0,2}$/).refine((value) => value.length % 4 === 0) }).strict(),
  artifactMissingAssetSchema,
]);
export const artifactMetadataSchema = z.object({
  id: artifactIdSchema, kind: artifactKindSchema, title: z.string().min(1).max(120),
  createdAt: z.number().int().nonnegative(),
  source: artifactCallSchema.extend({ producer: roleSchema, messageId: artifactText.optional() }).strict(),
  interaction: artifactInteractionSchema,
  incompleteAssets: z.array(artifactMissingAssetSchema).max(256),
}).strict();
export const artifactPayloadSchema = z.object({
  version: z.literal(1), body: artifactBodySchema, assets: z.array(artifactAssetSchema).max(256),
}).strict();
export const artifactManifestSchema = z.object({
  version: z.literal(1), binding: artifactBindingSchema, metadata: artifactMetadataSchema,
  inputDigest: artifactDigestSchema, payloadDigest: artifactDigestSchema,
  payloadBytes: z.number().int().positive().max(BOT_ARTIFACT_PAYLOAD_BYTES),
}).strict();
export const artifactPageSchema = z.object({
  offset: z.coerce.number().int().nonnegative().max(4096).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();
export type BotArtifactBinding = z.output<typeof artifactBindingSchema>;
export type BotArtifactCall = z.output<typeof artifactCallSchema>;
export type BotArtifactBody = z.output<typeof artifactBodySchema>;
export type BotArtifactMetadata = z.output<typeof artifactMetadataSchema>;
export type BotArtifactPayload = z.output<typeof artifactPayloadSchema>;
export type BotArtifactManifest = z.output<typeof artifactManifestSchema>;
export type BotArtifactAsset = z.output<typeof artifactAssetSchema>;
export type BotArtifactPage = z.input<typeof artifactPageSchema>;
export type BotArtifactReference = BotArtifactMetadata & { readonly publication: 'captured' | 'published' };

export class BotArtifactError extends Error {
  override readonly name = 'BotArtifactError';
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 409) { super(code); this.code = code; this.status = status; }
}
export const artifactHash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export const artifactIdFor = (call: BotArtifactCall) => `artifact_${artifactHash(JSON.stringify([call.sessionId, call.callId]))}`;
export const sameArtifactBinding = (left: BotArtifactBinding, right: BotArtifactBinding) =>
  JSON.stringify(artifactBindingSchema.parse(left)) === JSON.stringify(artifactBindingSchema.parse(right));

export function assertArtifactManifest(manifest: BotArtifactManifest, binding: BotArtifactBinding) {
  const { metadata } = manifest;
  if (!sameArtifactBinding(manifest.binding, binding) || metadata.id !== artifactIdFor(metadata.source)
    || metadata.source.sessionId !== binding.sessionId || JSON.stringify(metadata.source.producer) !== JSON.stringify(binding.producer)) {
    throw new BotArtifactError('BOT_ARTIFACT_BINDING_MISMATCH', 403);
  }
  if (binding.producer.role === 'stage' && metadata.interaction !== 'none') {
    throw new BotArtifactError('BOT_ARTIFACT_WORKER_READONLY', 403);
  }
}

export function assertArtifactPayload(manifest: BotArtifactManifest, bytes: Uint8Array): BotArtifactPayload {
  if (bytes.byteLength !== manifest.payloadBytes || artifactHash(bytes) !== manifest.payloadDigest) {
    throw new BotArtifactError('BOT_ARTIFACT_PAYLOAD_CHANGED', 502);
  }
  const payload = artifactPayloadSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')));
  const expectedInput = artifactHash(JSON.stringify({ binding: manifest.binding, body: payload.body,
    kind: manifest.metadata.kind, title: manifest.metadata.title, interaction: manifest.metadata.interaction }));
  const missing = payload.assets.filter((asset) => asset.status !== 'ready');
  let size = 0;
  for (const asset of payload.assets) {
    switch (asset.status) {
      case 'ready': {
        const decoded = Buffer.from(asset.data, 'base64');
        if (decoded.length > BOT_ARTIFACT_IMAGE_BYTES || decoded.toString('base64') !== asset.data) {
          throw new BotArtifactError('BOT_ARTIFACT_IMAGE_INVALID', 502);
        }
        size += decoded.length;
        break;
      }
      case 'missing': case 'rejected': case 'too-heavy': case 'external': break;
      default: assertNever(asset);
    }
  }
  if (expectedInput !== manifest.inputDigest || size > BOT_ARTIFACT_ASSET_BYTES || new Set(payload.assets.map((asset) => asset.source)).size !== payload.assets.length
    || JSON.stringify(missing) !== JSON.stringify(manifest.metadata.incompleteAssets)) {
    throw new BotArtifactError('BOT_ARTIFACT_PAYLOAD_INVALID', 502);
  }
  return payload;
}

const sessionSchema = z.object({
  id: artifactText, location: z.object({ directory: z.string().min(1).max(4096) }),
  metadata: z.object({ openchamber: z.object({ automation: z.object({
    source: z.literal('bot'), projectId: artifactText, botId: artifactText, itemId: artifactText,
    role: z.enum(['stage', 'conversation']).optional(), stage: z.enum(['investigation', 'fixing', 'judge']).optional(),
  }) }) }),
});
const botMarkerSchema = z.object({ metadata: z.object({ openchamber: z.object({ automation: z.object({ source: z.literal('bot') }) }) }) });
export function botArtifactBindingFromSession(raw: unknown): BotArtifactBinding | null {
  if (!botMarkerSchema.safeParse(raw).success) return null;
  const session = sessionSchema.parse(raw);
  const automation = session.metadata.openchamber.automation;
  let producer: z.input<typeof roleSchema>;
  switch (automation.role) {
    case 'conversation': producer = { role: 'conversation' }; break;
    case 'stage': case undefined: producer = roleSchema.parse({ role: 'stage', stage: automation.stage }); break;
    default: return assertNever(automation.role);
  }
  return artifactBindingSchema.parse({
    projectId: automation.projectId, botId: automation.botId, itemId: automation.itemId,
    sessionId: session.id, directory: session.location.directory, producer,
  });
}

function assertNever(value: never): never { throw new TypeError(`Unexpected bot artifact role: ${String(value)}`); }
