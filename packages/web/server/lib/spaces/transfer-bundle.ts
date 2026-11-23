import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import type { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';

import { SpaceError } from './errors.js';
import { createHostGit } from './host-git.js';
import { runCommand } from './run-command.js';
import { EXT_UNCARRIABLE, line, objectIdPattern, spaceRefPrefix } from './code-transfer.js';
import type { HostGit } from './code-transfer.js';
import type { CommandOptions } from './command-contracts.js';
import type { BundleDirectory, BundleDirectoryOptions, BundleExpectation, ResultBundleRequest, SnapshotMetadata, TransferCaps } from './transfer-bundle-contracts.js';
import { requiredFailureProperty } from './failure.js';

export const SPACE_TRANSFER_ROUTE = '/api/openchamber/space-transfer';

const text = z.string().max(4096).refine((value) => !EXT_UNCARRIABLE.test(value));
const oid = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const identity = z.string().max(256).refine((value) => !EXT_UNCARRIABLE.test(value));
const absoluteDirectory = text.min(1).refine((value) => path.isAbsolute(value));
export const transferSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('project'), directory: absoluteDirectory }).strict(),
  z.object({ kind: z.literal('bot-checkout'), projectDirectory: absoluteDirectory, projectId: text.min(1),
    botId: text.min(1), itemId: text.min(1), checkoutKey: text.min(1) }).strict(),
]);
export const sameTransferSource = (left: z.infer<typeof transferSourceSchema> | undefined, right: z.infer<typeof transferSourceSchema> | undefined) => JSON.stringify(transferSourceSchema.parse(left)) === JSON.stringify(transferSourceSchema.parse(right));
export const botMigrationPathSchema = z.object({ projectId: text.min(1), itemId: text.min(1), directory: absoluteDirectory,
  directoryIdentity: z.string().regex(/^\d+:\d+$/), gitDirectory: absoluteDirectory, gitIdentity: z.string().regex(/^\d+:\d+$/) }).strict();
export const sameBotMigrationPath = (left: z.infer<typeof botMigrationPathSchema> | undefined, right: z.infer<typeof botMigrationPathSchema> | undefined) => JSON.stringify(botMigrationPathSchema.parse(left)) === JSON.stringify(botMigrationPathSchema.parse(right));
const migrationPathsSchema = z.object({ version: z.literal(1), entries: z.array(botMigrationPathSchema) }).strict()
  .refine((value) => new Set(value.entries.map((entry) => `${entry.projectId}\0${entry.itemId}`)).size === value.entries.length);

export async function readTrustedBotMigrationPaths({ dataDir }: { readonly dataDir: string }) {
  let raw;
  try { raw = await fs.readFile(path.join(dataDir, 'bots', 'migration-paths.json'), 'utf8'); }
  catch (error) { if (requiredFailureProperty(error, 'code') === 'ENOENT') return Object.freeze([]); throw error; }
  let value;
  try { value = JSON.parse(raw); } catch { throw bundleFailure('BOT_MIGRATION_PATH_AUTHORITY_INVALID'); }
  const parsed = migrationPathsSchema.safeParse(value);
  if (!parsed.success) throw bundleFailure('BOT_MIGRATION_PATH_AUTHORITY_INVALID');
  return Object.freeze(parsed.data.entries.map((entry) => Object.freeze(entry)));
}
const snapshotMetadataSchema = z.object({
  version: z.literal(1), mode: z.enum(['clean', 'uncommitted']), directory: text.min(1),
  repository: text.min(1), prefix: text, objectFormat: z.enum(['sha1', 'sha256']),
  base: oid, staged: oid, start: oid, branch: text.max(256).nullable(),
  identity: z.object({ name: identity, email: identity }).strict(), ref: text,
  shallow: z.array(oid).max(100000),
  source: transferSourceSchema.optional(),
  trustedMigrationPath: botMigrationPathSchema.optional(),
}).strict();

export const bundleFailure = (code = 'agent_bundle_invalid') => new SpaceError(code, code);

export function transferCaps(environment: NodeJS.ProcessEnv = process.env) {
  const read = (key: string, fallback: number) => {
    const value = environment[key] === undefined ? fallback : Number(environment[key]);
    if (!Number.isSafeInteger(value) || value < 1) throw bundleFailure('agent_transfer_invalid_limit');
    return value;
  };
  return {
    bundleBytes: read('OPENCHAMBER_SPACE_BUNDLE_MAX_BYTES', 512 * 1024 * 1024),
    metadataBytes: read('OPENCHAMBER_SPACE_METADATA_MAX_BYTES', 16 * 1024),
    timeoutMs: read('OPENCHAMBER_SPACE_AGENT_TIMEOUT_MS', 10 * 60_000),
  };
}

export function parseSnapshotMetadata<Value>(value: Value, spaceId: string) {
  const parsed = snapshotMetadataSchema.safeParse(value);
  if (!parsed.success) throw bundleFailure('agent_metadata_invalid');
  const metadata = parsed.data;
  if (metadata.ref !== `${spaceRefPrefix(spaceId)}start`
    || ![metadata.base, metadata.staged, metadata.start].every((id) => objectIdPattern(metadata.objectFormat).test(id))
    || !metadata.shallow.every((id) => objectIdPattern(metadata.objectFormat).test(id))
    || !path.isAbsolute(metadata.repository) || !path.isAbsolute(metadata.directory)
    || metadata.prefix.startsWith('/') || metadata.prefix.split('/').some((part) => part === '..' || part === '.')
    || metadata.prefix.includes('\\')
    || path.resolve(metadata.repository, metadata.prefix) !== metadata.directory
    || metadata.trustedMigrationPath && (metadata.source?.kind !== 'bot-checkout'
      || metadata.source.projectId !== metadata.trustedMigrationPath.projectId || metadata.source.itemId !== metadata.trustedMigrationPath.itemId
      || metadata.directory !== metadata.trustedMigrationPath.directory)
    || metadata.mode === 'clean' && (metadata.base !== metadata.staged || metadata.base !== metadata.start)
    || metadata.mode === 'uncommitted' && (metadata.start === metadata.staged || metadata.staged === metadata.base)) {
    throw bundleFailure('agent_metadata_invalid');
  }
  return metadata;
}

const configValue = (value: string) => {
  if (EXT_UNCARRIABLE.test(value)) throw bundleFailure('agent_directory_invalid');
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
};

export async function withBundleDirectory<Result>(options: BundleDirectoryOptions, work: (context: BundleDirectory) => Promise<Result>): Promise<Result> {
  const parent = options.temporaryDirectory ?? os.tmpdir();
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = await fs.mkdtemp(path.join(parent, 'openchamber-bundle-'));
  await fs.chmod(directory, 0o700);
  try {
    const hooks = path.join(directory, 'no-hooks');
    await fs.mkdir(hooks, { mode: 0o700 });
    const trust = options.trust ?? [];
    const globalConfig = trust.length ? path.join(directory, 'trust.gitconfig') : os.devNull;
    if (trust.length) {
      await fs.writeFile(globalConfig, `[safe]\n${trust.map((folder) => `\tdirectory = ${configValue(folder)}\n`).join('')}`, { mode: 0o600, flag: 'wx' });
    }
    const gitOptions: Parameters<typeof createHostGit>[0] = { runCommand: options.runCommand ?? runCommand, environment: options.environment ?? process.env };
    if (options.gitPath !== undefined) gitOptions.gitPath = options.gitPath;
    const git = createHostGit(gitOptions);
    const config = ['-c', `core.hooksPath=${hooks}`, '-c', 'core.fsmonitor=false',
      '-c', 'transfer.fsckObjects=true', '-c', 'fetch.fsckObjects=true', '-c', 'receive.fsckObjects=true'];
    const boundedOptions = (request: CommandOptions): CommandOptions => ({
      ...request, timeoutMs: Math.min(request.timeoutMs ?? options.caps.timeoutMs, options.caps.timeoutMs), killTree: true,
      env: { ...request.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1' },
    });
    const bounded: HostGit = {
      run: (where, args, request = {}) => git.run(where, [...config, ...args], boundedOptions(request)),
      output: (where, args, request = {}) => git.output(where, [...config, ...args], boundedOptions(request)),
      fsmonitor: 'false',
    };
    return await work({ directory, git: bounded });
  } finally {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

export async function streamBundle(source: Readable, destination: Writable, caps: TransferCaps) {
  let bytes = 0;
  const limit = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    bytes += chunk.length;
    callback(bytes > caps.bundleBytes ? bundleFailure('agent_bundle_too_large') : null, chunk);
  } });
  try {
    await pipeline(source, limit, destination, { signal: AbortSignal.timeout(caps.timeoutMs) });
  } catch (error) {
    if (error instanceof SpaceError) throw error;
    throw bundleFailure('agent_bundle_stream_failed');
  }
}

export const receiveBundle = (source: Readable, file: string, caps: TransferCaps) => streamBundle(source, createWriteStream(file, { flags: 'wx', mode: 0o600 }), caps);

export async function checkBundleHeader(file: string, expected: BundleExpectation) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (stat.size > expected.caps.bundleBytes) throw bundleFailure('agent_bundle_too_large');
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const end = buffer.subarray(0, bytesRead).indexOf('\n\n');
    if (end < 0) throw bundleFailure();
    const lines = buffer.subarray(0, end).toString('utf8').split('\n');
    const version = lines.shift();
    if (version !== '# v2 git bundle' && version !== '# v3 git bundle') throw bundleFailure();
    if (version === '# v3 git bundle' && lines.shift() !== `@object-format=${expected.objectFormat}`) throw bundleFailure();
    if (version === '# v2 git bundle' && expected.objectFormat !== 'sha1') throw bundleFailure();
    const refs = [];
    const prerequisites = [];
    for (const entry of lines) {
      if (entry.startsWith('-')) {
        const id = entry.slice(1).split(' ')[0] ?? '';
        if (!objectIdPattern(expected.objectFormat).test(id)) throw bundleFailure();
        prerequisites.push(id);
      } else refs.push(entry);
    }
    if (refs.length !== 1 || refs[0] !== `${expected.id} ${expected.ref}`
      || prerequisites.length !== (expected.prerequisite ? 1 : 0)
      || expected.prerequisite && prerequisites[0] !== expected.prerequisite) throw bundleFailure();
    return end + 2;
  } finally { await handle.close(); }
}

export async function importBundle(git: HostGit, repository: string, file: string, expected: BundleExpectation) {
  await checkBundleHeader(file, expected);
  await git.output(repository, ['bundle', 'verify', file]);
  await git.output(repository, ['-c', 'transfer.fsckObjects=true', '-c', 'fetch.fsckObjects=true', 'fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head',
    '--no-auto-gc', '--refmap=', file, `+${expected.ref}:${expected.ref}`]);
  if (line(await git.output(repository, ['rev-parse', '--verify', `${expected.ref}^{commit}`])) !== expected.id) throw bundleFailure();
}

export async function writeBundle(git: HostGit, repository: string, file: string, { revisions, caps }: { readonly revisions: readonly string[]; readonly caps: TransferCaps }) {
  const controller = new AbortController();
  let checking = false;
  const timer = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      if ((await fs.stat(file)).size > caps.bundleBytes) controller.abort(bundleFailure('agent_bundle_too_large'));
    } catch { return; }
    finally { checking = false; }
  }, 100);
  timer.unref();
  try {
    await git.output(repository, ['bundle', 'create', file, ...revisions], { signal: controller.signal, timeoutMs: caps.timeoutMs });
    if ((await fs.stat(file)).size > caps.bundleBytes) throw bundleFailure('agent_bundle_too_large');
  } finally { clearInterval(timer); }
}

export async function checkSnapshotChain(git: HostGit, repository: string, metadata: SnapshotMetadata) {
  for (const id of new Set([metadata.base, metadata.staged, metadata.start])) {
    if (line(await git.output(repository, ['cat-file', '-t', id])) !== 'commit') throw bundleFailure('agent_snapshot_chain_invalid');
  }
  if (metadata.mode === 'uncommitted') {
    for (const [child, parent] of [[metadata.start, metadata.staged], [metadata.staged, metadata.base]] as const) {
      if (line(await git.output(repository, ['rev-list', '--parents', '--max-count=1', child], { maxOutputBytes: 1024 })) !== `${child} ${parent}`) {
        throw bundleFailure('agent_snapshot_chain_invalid');
      }
    }
  }
  if (metadata.branch !== null) {
    if (metadata.branch.startsWith('-') || line(await git.output(repository, ['check-ref-format', '--branch', metadata.branch])) !== metadata.branch) throw bundleFailure('agent_metadata_invalid');
  }
}

export async function makeResultBundle(git: HostGit, repository: string, file: string, request: ResultBundleRequest) {
  const ref = `${spaceRefPrefix(request.spaceId)}result`;
  const raw = `${file}.raw`;
  const contained = (await git.run(repository, ['merge-base', '--is-ancestor', request.result, request.start])).code === 0;
  await writeBundle(git, repository, raw, { caps: request.caps, revisions: [ref, ...(contained ? [] : [`^${request.start}`])] });
  const handle = await fs.open(raw, 'r');
  let offset;
  try {
    const header = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    offset = header.subarray(0, bytesRead).indexOf('\n\n') + 2;
    if (offset < 2) throw bundleFailure();
  } finally { await handle.close(); }
  const version = request.objectFormat === 'sha1' ? '# v2 git bundle\n' : '# v3 git bundle\n@object-format=sha256\n';
  await fs.writeFile(file, `${version}-${request.start} start\n${request.result} ${ref}\n\n`, { mode: 0o600 });
  await streamBundle(createReadStream(raw, { start: offset }), createWriteStream(file, { flags: 'a' }), request.caps);
  await checkBundleHeader(file, { ...request, id: request.result, ref, prerequisite: request.start });
}
