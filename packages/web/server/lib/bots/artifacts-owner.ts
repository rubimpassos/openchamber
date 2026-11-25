import path from 'node:path';
import {
  BOT_ARTIFACT_CHUNK_BYTES, BotArtifactError, artifactBindingSchema, artifactManifestSchema,
  assertArtifactManifest, sameArtifactBinding,
} from './artifacts-contract.js';
import type { BotArtifactBinding, BotArtifactManifest, BotArtifactPage } from './artifacts-contract.js';
import { artifactChunkReplySchema, artifactPullReplySchema } from '../agent-server/bot-artifact-service-contract.js';
import type { BotArtifactTransport } from '../agent-server/bot-artifact-service-contract.js';
import { createBotArtifactStore } from './artifacts-store.js';
import type { RenderedPageProjection } from '../openchamber-control/page-projection.js';

type ItemScope = { readonly projectId: string; readonly itemId: string };
type SnapshotTransport = Pick<BotArtifactTransport, 'pull' | 'chunk'>;
type OwnerOptions = {
  readonly dataDir: string;
  readonly resolveBinding: (sessionId: string) => Promise<BotArtifactBinding | null>;
  readonly assertReadScope: (scope: ItemScope) => Promise<void>;
  readonly fsImpl?: Parameters<typeof createBotArtifactStore>[0]['fsImpl'];
  readonly readPage?: (manifest: BotArtifactManifest) => Promise<RenderedPageProjection | null>;
};
const scopeFor = (scope: ItemScope) => ['item', scope.projectId, scope.itemId];

export function createBotArtifacts({ dataDir, resolveBinding, assertReadScope, fsImpl, readPage }: OwnerOptions) {
  let storage: Parameters<typeof createBotArtifactStore>[0] = { directory: path.join(dataDir, 'bots', 'artifacts') };
  if (fsImpl) storage = { ...storage, fsImpl };
  const store = createBotArtifactStore(storage);
  const transfers = new Set<Promise<unknown>>();
  const track = <Value>(run: Promise<Value>): Promise<Value> => {
    transfers.add(run);
    void run.then(() => transfers.delete(run), () => transfers.delete(run));
    return run;
  };
  const authorize = async (binding: BotArtifactBinding) => {
    const recorded = await resolveBinding(binding.sessionId);
    if (!recorded || !sameArtifactBinding(artifactBindingSchema.parse(recorded), binding)) {
      throw new BotArtifactError('BOT_ARTIFACT_BINDING_REQUIRED', 403);
    }
  };
  const publish = (binding: BotArtifactBinding, raw: BotArtifactManifest, bytes: Uint8Array) => track((async () => {
    const parsedBinding = artifactBindingSchema.parse(binding);
    const manifest = artifactManifestSchema.parse(raw);
    await authorize(parsedBinding);
    assertArtifactManifest(manifest, parsedBinding);
    const saved = await store.write(scopeFor(parsedBinding), manifest, bytes);
    return saved.metadata;
  })());
  const list = async (scope: ItemScope, page: BotArtifactPage = {}) => {
    await assertReadScope(scope);
    const result = await store.manifests(scopeFor(scope), page);
    for (const entry of result.entries) {
      if (entry.binding.projectId !== scope.projectId || entry.binding.itemId !== scope.itemId) {
        throw new BotArtifactError('BOT_ARTIFACT_BINDING_MISMATCH', 403);
      }
    }
    return { artifacts: result.entries.map((entry) => entry.metadata), nextOffset: result.nextOffset };
  };
  const read = async (scope: ItemScope, id: string) => {
    await assertReadScope(scope);
    const manifest = await store.manifest(scopeFor(scope), id);
    if (manifest.binding.projectId !== scope.projectId || manifest.binding.itemId !== scope.itemId) {
      throw new BotArtifactError('BOT_ARTIFACT_BINDING_MISMATCH', 403);
    }
    const payload = (await store.payload(manifest)).payload;
    const saved = { artifact: manifest.metadata, payload };
    if (!readPage) return saved;
    try { return { ...saved, page: await readPage(manifest) }; }
    catch (error) {
      if (!(error instanceof Error)) throw error;
      return { ...saved, pageError: 'BOT_ARTIFACT_PAGE_UNAVAILABLE' as const };
    }
  };
  const collectSession = async (binding: BotArtifactBinding, transport: SnapshotTransport, signal?: AbortSignal) => {
    const parsedBinding = artifactBindingSchema.parse(binding);
    await authorize(parsedBinding);
    let offset = 0;
    let collected = 0;
    do {
      signal?.throwIfAborted();
      const page = artifactPullReplySchema.parse(await transport.pull({ binding: parsedBinding, offset }, signal));
      if (page.nextOffset !== null && (page.entries.length !== 1 || page.nextOffset !== offset + 1)) {
        throw new BotArtifactError('BOT_ARTIFACT_PAGE_INVALID', 502);
      }
      for (const raw of page.entries) {
        const manifest = artifactManifestSchema.parse(raw);
        assertArtifactManifest(manifest, parsedBinding);
        const existing = await store.find(scopeFor(parsedBinding), manifest.metadata.id);
        if (existing) {
          if (JSON.stringify(existing) !== JSON.stringify(manifest)) throw new BotArtifactError('BOT_ARTIFACT_CONTENT_CONFLICT');
          collected += 1;
          continue;
        }
        const bytes = Buffer.alloc(manifest.payloadBytes);
        for (let position = 0; position < bytes.length; position += BOT_ARTIFACT_CHUNK_BYTES) {
          signal?.throwIfAborted();
          const reply = artifactChunkReplySchema.parse(await transport.chunk({
            binding: parsedBinding, id: manifest.metadata.id, callId: manifest.metadata.source.callId, offset: position,
          }, signal));
          const chunk = Buffer.from(reply.data, 'base64');
          if (reply.id !== manifest.metadata.id || reply.payloadDigest !== manifest.payloadDigest || reply.offset !== position
            || chunk.length !== Math.min(BOT_ARTIFACT_CHUNK_BYTES, bytes.length - position)) {
            throw new BotArtifactError('BOT_ARTIFACT_CHUNK_MISMATCH', 502);
          }
          bytes.set(chunk, position);
        }
        await publish(parsedBinding, manifest, bytes);
        collected += 1;
      }
      if (page.nextOffset === null) return { collected };
      offset = page.nextOffset;
    } while (offset <= 4096);
    throw new BotArtifactError('BOT_ARTIFACT_PAGE_INVALID', 502);
  };
  const collect = (binding: BotArtifactBinding, transport: SnapshotTransport, signal?: AbortSignal) => track(collectSession(binding, transport, signal));
  const flush = async () => {
    const settled = await Promise.allSettled([...transfers]);
    const failures: unknown[] = settled.filter((result) => result.status === 'rejected').map((result) => result.reason);
    if (failures.length) throw new AggregateError(failures, 'Bot artifact publication could not fully drain');
  };
  return { publish, list, read, collect, flush };
}
