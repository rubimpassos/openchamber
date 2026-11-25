import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { withSourceControlFileLock } from '../source-control/file-lock.js';
import { hasSourceControlErrorCode } from '../source-control/input-guards.js';
import {
  BOT_ARTIFACT_CATALOG_BYTES, BOT_ARTIFACT_PAYLOAD_BYTES, BOT_ARTIFACT_CHUNK_BYTES, BotArtifactError, artifactHash,
  artifactIdSchema, artifactManifestSchema, artifactPageSchema, assertArtifactPayload,
} from './artifacts-contract.js';
import type { BotArtifactManifest, BotArtifactPage } from './artifacts-contract.js';

type StoreOptions = { readonly directory: string; readonly fsImpl?: typeof fs };
type Snapshot = { readonly manifest: BotArtifactManifest; readonly bytes: Uint8Array };
const catalogSchema = z.object({ version: z.literal(1), entries: z.array(artifactManifestSchema).max(4096) }).strict();
type Catalog = z.output<typeof catalogSchema>;

export function createBotArtifactStore({ directory, fsImpl = fs }: StoreOptions) {
  const fileFor = (scope: readonly string[]) => path.join(directory, 'catalogs', `${artifactHash(JSON.stringify(scope))}.json`);
  const blobFor = (digest: string) => path.join(directory, 'blobs', `${digest}.json`);
  const readBytes = async (file: string, cap: number) => {
    const handle = await fsImpl.open(file, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > cap) throw new BotArtifactError('BOT_ARTIFACT_STORAGE_LIMIT', 413);
      const bytes = await handle.readFile();
      if (bytes.length > cap) throw new BotArtifactError('BOT_ARTIFACT_STORAGE_LIMIT', 413);
      return bytes;
    } finally { await handle.close(); }
  };
  const load = async (file: string): Promise<Catalog> => {
    try { return catalogSchema.parse(JSON.parse((await readBytes(file, BOT_ARTIFACT_CATALOG_BYTES)).toString('utf8'))); }
    catch (error) {
      if (hasSourceControlErrorCode(error) && error.code === 'ENOENT') return { version: 1, entries: [] };
      throw error;
    }
  };
  const locked = <T>(scope: readonly string[], run: (catalog: Catalog) => Promise<T>) =>
    withSourceControlFileLock(`${fileFor(scope)}.lock`, async () => run(await load(fileFor(scope))), { fsImpl, waitMs: 10_000 });
  const atomicWrite = async (file: string, bytes: Uint8Array, immutable: boolean) => {
    await fsImpl.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await fsImpl.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      if (immutable) {
        try { await fsImpl.link(temporary, file); }
        catch (error) { if (!hasSourceControlErrorCode(error) || error.code !== 'EEXIST') throw error; }
      } else await fsImpl.rename(temporary, file);
    } finally { await fsImpl.rm(temporary, { force: true }); }
  };
  const commit = async (scope: readonly string[], catalog: Catalog, { manifest, bytes }: Snapshot) => {
    const entries = [...catalog.entries, manifest].sort((left, right) =>
      left.metadata.createdAt - right.metadata.createdAt || left.metadata.id.localeCompare(right.metadata.id));
    const serialized = Buffer.from(JSON.stringify(catalogSchema.parse({ version: 1, entries })));
    if (serialized.length > BOT_ARTIFACT_CATALOG_BYTES) throw new BotArtifactError('BOT_ARTIFACT_CATALOG_FULL', 413);
    await atomicWrite(blobFor(manifest.payloadDigest), bytes, true);
    await atomicWrite(fileFor(scope), serialized, false);
    return manifest;
  };
  const write = async (scope: readonly string[], manifest: BotArtifactManifest, bytes: Uint8Array) => locked(scope, async (catalog) => {
    assertArtifactPayload(manifest, bytes);
    const previous = catalog.entries.find((entry) => entry.metadata.id === manifest.metadata.id);
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(manifest)) throw new BotArtifactError('BOT_ARTIFACT_CONTENT_CONFLICT');
      return previous;
    }
    return commit(scope, catalog, { manifest, bytes });
  });
  const capture = async (scope: readonly string[], identity: { readonly id: string; readonly inputDigest: string },
    produce: () => Promise<Snapshot>) => locked(scope, async (catalog) => {
    const previous = catalog.entries.find((entry) => entry.metadata.id === identity.id);
    if (previous) {
      if (previous.inputDigest !== identity.inputDigest) throw new BotArtifactError('BOT_ARTIFACT_CONTENT_CONFLICT');
      return previous;
    }
    const produced = await produce();
    assertArtifactPayload(produced.manifest, produced.bytes);
    return commit(scope, catalog, produced);
  });
  const manifests = async (scope: readonly string[], page: BotArtifactPage = {}) => locked(scope, async (catalog) => {
    const { offset, limit } = artifactPageSchema.parse(page);
    return { entries: catalog.entries.slice(offset, offset + limit), nextOffset: offset + limit < catalog.entries.length ? offset + limit : null };
  });
  const find = async (scope: readonly string[], id: string) => locked(scope, async (catalog) =>
    catalog.entries.find((entry) => entry.metadata.id === artifactIdSchema.parse(id)) ?? null);
  const manifest = async (scope: readonly string[], id: string) => {
    const entry = await find(scope, id);
    if (!entry) throw new BotArtifactError('BOT_ARTIFACT_NOT_FOUND', 404);
    return entry;
  };
  const payload = async (entry: BotArtifactManifest) => {
    const bytes = await readBytes(blobFor(entry.payloadDigest), BOT_ARTIFACT_PAYLOAD_BYTES);
    return { bytes, payload: assertArtifactPayload(entry, bytes) };
  };
  const chunk = async (entry: BotArtifactManifest, offset: number) => {
    const handle = await fsImpl.open(blobFor(entry.payloadDigest), 'r');
    try {
      const bytes = Buffer.alloc(Math.min(BOT_ARTIFACT_CHUNK_BYTES, entry.payloadBytes - offset));
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, offset);
      if (bytesRead !== bytes.length) throw new BotArtifactError('BOT_ARTIFACT_TRANSFER_INCOMPLETE', 502);
      return bytes;
    } finally { await handle.close(); }
  };
  return { capture, write, manifests, manifest, find, payload, chunk };
}
