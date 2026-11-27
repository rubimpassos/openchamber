import path from 'node:path';
import {
  BOT_ARTIFACT_PAYLOAD_BYTES, BotArtifactError, artifactBindingSchema, artifactBodySchema, artifactHash,
  artifactIdFor, artifactKindSchema, artifactManifestSchema, artifactRequirementSchema, artifactCallSchema, artifactInteractionSchema,
  assertArtifactManifest, artifactText,
} from './artifacts-contract.js';
import type { BotArtifactBinding, BotArtifactBody, BotArtifactCall, BotArtifactManifest, BotArtifactMetadata, BotArtifactPage, BotArtifactReference } from './artifacts-contract.js';
import { captureArtifactImages } from './artifacts-images.js';
import { createBotArtifactStore } from './artifacts-store.js';

export type BotRenderCaptureInput = {
  readonly body: BotArtifactBody; readonly title: string; readonly artifactKind?: unknown; readonly artifactFor?: unknown;
  readonly awaitAnswer?: unknown; readonly answerLater?: unknown; readonly share?: unknown;
};
export type BotRenderCaptureContext = {
  readonly sessionId?: string | null | undefined; readonly callId?: string | null | undefined;
  readonly directory?: string | null | undefined; readonly signal?: AbortSignal | undefined;
  readonly messageId?: string | undefined;
};
type CaptureOptions = {
  readonly dataDir: string;
  readonly resolveSession: (sessionId: string) => Promise<BotArtifactBinding | null>;
  readonly onCaptured: (manifest: BotArtifactManifest) => Promise<void>;
  readonly publish?: (manifest: BotArtifactManifest, bytes: Uint8Array) => Promise<BotArtifactMetadata>;
  readonly now?: () => number;
};
export const artifactSessionScope = (sessionId: string) => ['session', sessionId];

export function createBotArtifactCapture({ dataDir, resolveSession, onCaptured, publish, now = Date.now }: CaptureOptions) {
  const store = createBotArtifactStore({ directory: path.join(dataDir, 'bots', 'artifact-captures') });
  const captures = new Map<string, Set<Promise<unknown>>>();
  const captureSnapshot = async (input: BotRenderCaptureInput, context: BotRenderCaptureContext): Promise<BotArtifactReference | null> => {
    if (input.artifactKind !== undefined && !artifactKindSchema.safeParse(input.artifactKind).success) {
      throw new BotArtifactError('BOT_ARTIFACT_KIND_INVALID', 400);
    }
    if (input.artifactFor !== undefined && !artifactRequirementSchema.safeParse(input.artifactFor).success) {
      throw new BotArtifactError('BOT_ARTIFACT_REQUIREMENT_INVALID', 400);
    }
    const categorized = input.artifactKind !== undefined || input.artifactFor !== undefined;
    if (!context.sessionId) {
      if (categorized) throw new BotArtifactError('BOT_ARTIFACT_SESSION_REQUIRED', 400);
      return null;
    }
    const resolved = await resolveSession(context.sessionId);
    if (!resolved) {
      if (categorized) throw new BotArtifactError('BOT_ARTIFACT_BOT_SESSION_REQUIRED', 403);
      return null;
    }
    const binding = artifactBindingSchema.parse(resolved);
    if (binding.sessionId !== context.sessionId || binding.directory !== context.directory) {
      throw new BotArtifactError('BOT_ARTIFACT_BINDING_MISMATCH', 403);
    }
    const call = artifactCallSchema.parse({ sessionId: context.sessionId, callId: context.callId });
    const interaction = artifactInteractionSchema.parse(input.share != null ? 'share'
      : input.answerLater === true ? 'answerLater' : input.awaitAnswer === true ? 'awaitAnswer' : 'none');
    if (binding.producer.role === 'stage' && interaction !== 'none') {
      throw new BotArtifactError('BOT_ARTIFACT_WORKER_READONLY', 403);
    }
    context.signal?.throwIfAborted();
    const body = artifactBodySchema.parse(input.body);
    const kind = artifactKindSchema.parse(input.artifactKind ?? 'evidence');
    const requirement = input.artifactFor === undefined ? undefined : artifactRequirementSchema.parse(input.artifactFor);
    const inputDigest = artifactHash(JSON.stringify({ binding, body, kind, title: input.title, interaction, requirement }));
    const manifest = await store.capture(artifactSessionScope(call.sessionId), { id: artifactIdFor(call), inputDigest }, async () => {
      const assets = await captureArtifactImages(body, {
        directory: binding.directory, temporaryRoot: path.join(dataDir, 'bots', 'artifact-capture-temporary'),
      });
      const bytes = Buffer.from(JSON.stringify({ version: 1, body, assets }));
      if (bytes.length > BOT_ARTIFACT_PAYLOAD_BYTES) throw new BotArtifactError('BOT_ARTIFACT_PAYLOAD_TOO_LARGE', 413);
      const source: BotArtifactMetadata['source'] = { ...call, producer: binding.producer };
      if (context.messageId) source.messageId = artifactText.parse(context.messageId);
      const metadata: BotArtifactMetadata = { id: artifactIdFor(call), kind, title: input.title, createdAt: now(),
        source,
        interaction, incompleteAssets: assets.filter((asset) => asset.status !== 'ready') };
      if (requirement) metadata.requirement = requirement;
      return { bytes, manifest: artifactManifestSchema.parse({
        version: 1, binding, metadata, inputDigest, payloadDigest: artifactHash(bytes), payloadBytes: bytes.length,
      }) };
    });
    assertArtifactManifest(manifest, binding);
    await onCaptured(manifest);
    if (publish) {
      const { bytes } = await store.payload(manifest);
      return { ...await publish(manifest, bytes), publication: 'published' };
    }
    return { ...manifest.metadata, publication: 'captured' };
  };
  const capture = (input: BotRenderCaptureInput, context: BotRenderCaptureContext) => {
    const run = captureSnapshot(input, context);
    const sessionId = context.sessionId ?? '';
    const pending = captures.get(sessionId) ?? new Set<Promise<unknown>>();
    pending.add(run); captures.set(sessionId, pending);
    const release = () => { pending.delete(run); if (pending.size === 0) captures.delete(sessionId); };
    void run.then(release, release);
    return run;
  };
  const flush = async (sessionId?: string) => {
    const pending = sessionId === undefined ? [...captures.values()].flatMap((runs) => [...runs]) : [...(captures.get(sessionId) ?? [])];
    const settled = await Promise.allSettled(pending);
    const failures: unknown[] = settled.filter((result) => result.status === 'rejected').map((result) => result.reason);
    if (failures.length) throw new AggregateError(failures, 'Bot artifact capture could not fully drain');
  };
  const list = async (binding: BotArtifactBinding, page: BotArtifactPage = {}) => {
    const parsed = artifactBindingSchema.parse(binding);
    const result = await store.manifests(artifactSessionScope(parsed.sessionId), page);
    for (const entry of result.entries) assertArtifactManifest(entry, parsed);
    return result;
  };
  const manifest = async (binding: BotArtifactBinding, id: string) => {
    const entry = await store.manifest(artifactSessionScope(binding.sessionId), id);
    assertArtifactManifest(entry, artifactBindingSchema.parse(binding));
    return entry;
  };
  const chunk = async (binding: BotArtifactBinding, input: BotArtifactCall & { readonly id: string; readonly offset: number }) => {
    const entry = await manifest(binding, input.id);
    if (entry.metadata.source.callId !== input.callId || entry.metadata.source.sessionId !== input.sessionId
      || !Number.isSafeInteger(input.offset) || input.offset < 0 || input.offset >= entry.payloadBytes) {
      throw new BotArtifactError('BOT_ARTIFACT_CHUNK_INVALID', 400);
    }
    return { id: entry.metadata.id, payloadDigest: entry.payloadDigest, offset: input.offset,
      data: (await store.chunk(entry, input.offset)).toString('base64') };
  };
  const isInteractiveSession = async (sessionId: string) => (await resolveSession(sessionId))?.producer.role !== 'stage';
  return { capture, list, manifest, chunk, flush, isInteractiveSession };
}
