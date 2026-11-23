import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { readBoundedBody } from '../agent-server/agent-upstream.js';
import type { AgentRequestOptions, AgentUpstreamResponse } from '../agent-server/agent-upstream.js';
import { spaceRefPrefix, transferValue, withTransferErrorDetails } from './code-transfer.js';
import { SpaceError } from './errors.js';
import { requireSpaceId } from './labels.js';
import { createSpaceRecords } from './space-records.js';
import { SPACE_TRANSFER_ROUTE, bundleFailure, checkSnapshotChain, importBundle, makeResultBundle, parseSnapshotMetadata,
  readTrustedBotMigrationPaths, receiveBundle, sameBotMigrationPath, sameTransferSource, transferCaps, transferSourceSchema, withBundleDirectory } from './transfer-bundle.js';
import type { AgentBundleOptions, AgentCodeInOptions, AgentCodeOutOptions, TransferJsonOptions, TransferMirror, TransferRequest, TransferSourceRequest } from './agent-code-transfer-contracts.js';
import type { BringRequest, HistoryRequest, HistoryResult, TransferOwner } from './code-in.js';
import type { ApplyRequest, CodeOutRequest, CodeOutSummary } from './code-out-contracts.js';
import type { SnapshotMetadata, TransferQueryParameters } from './transfer-bundle-contracts.js';
import { requiredFailureProperty } from './failure.js';
import { hasProperties } from '../shared/guards.js';
import { parseJson } from './json.js';
import type { JsonValue } from './json.js';

const hasFailureFields = (value: unknown): value is { details?: unknown; code?: unknown } => value != null;

const oid = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const count = z.number().int().nonnegative();
const reported = z.object({ count, paths: z.array(z.string().max(4096)).max(100) });
const summarySchema = z.object({ result: oid, changedPaths: count, changedBytes: count, newBytes: count,
  nestedRepositories: reported, unmerged: reported });
const stateSchema = z.object({ changesRoute: z.enum(['open', 'closed']), result: oid.nullable(), lastApplied: oid.nullable(),
  newPaths: count.nullable(), newPathsOverLimit: z.boolean(), newPathsUndecided: z.boolean(), interruptedApply: z.boolean() });
const branchSchema = z.object({ branch: z.string().min(1).max(256), commit: oid });
const changesSchema = z.discriminatedUnion('status', [z.object({ status: z.literal('nothing_to_apply') }),
  z.object({ status: z.literal('applied'), appliedPaths: count, remembered: z.boolean(), nestedRepositories: reported, conflicted: reported })]);

function agentTransfer(options: AgentBundleOptions) {
  const { upstream, dataDir, place } = options;
  const caps = transferCaps(options.environment);
  let migrationPaths: ReturnType<typeof readTrustedBotMigrationPaths> | undefined;
  const sourceOf = (input: TransferSourceRequest) => {
    const record = input.spaceId ? createSpaceRecords({ dataDir: transferValue(dataDir) }).read(input.spaceId).record : null;
    const saved = record?.repository === input.repository ? record.source : undefined;
    const source = transferSourceSchema.parse(input.source ?? saved ?? { kind: 'project', directory: input.repository });
    if (saved && !sameTransferSource(saved, source)) throw bundleFailure('agent_source_mismatch');
    return source;
  };
  const migrationPathOf = async (input: TransferSourceRequest) => {
    const source = sourceOf(input);
    if (source.kind !== 'bot-checkout') return undefined;
    migrationPaths ??= readTrustedBotMigrationPaths({ dataDir: transferValue(dataDir) });
    const captured = (await migrationPaths).find((entry) => entry.projectId === source.projectId && entry.itemId === source.itemId);
    const record = input.spaceId ? createSpaceRecords({ dataDir: transferValue(dataDir) }).read(input.spaceId).record : null;
    const saved = input.trustedMigrationPath ?? record?.trustedMigrationPath;
    if (saved && !captured) throw bundleFailure('BOT_MIGRATION_PATH_AUTHORITY_REQUIRED');
    if (saved && !sameBotMigrationPath(saved, captured)) throw bundleFailure('BOT_MIGRATION_PATH_AUTHORITY_MISMATCH');
    return captured;
  };
  const route = async (request: TransferRequest, operation: string, extra: Readonly<Record<string, string>> = {}) => {
    requireSpaceId(request.spaceId);
    const source = sourceOf(request);
    const trustedMigrationPath = await migrationPathOf(request);
    const directory = source.kind === 'project' ? source.directory : source.projectDirectory;
    const parameters: TransferQueryParameters = { directory, source: JSON.stringify(source) };
    if (trustedMigrationPath) parameters.trustedMigrationPath = JSON.stringify(trustedMigrationPath);
    Object.assign(parameters, extra);
    return `${SPACE_TRANSFER_ROUTE}/${request.spaceId}/${operation}?${new URLSearchParams(parameters)}`;
  };
  const responseJson = async (response: AgentUpstreamResponse): Promise<JsonValue> => {
    let value: JsonValue;
    try { value = parseJson(await readBoundedBody(response, caps.metadataBytes)); }
    catch { throw bundleFailure('agent_metadata_invalid'); }
    if (response.statusCode !== 200) {
      const code = z.string().regex(/^(?:[a-z_]{1,80}|BOT_MIGRATION_PATH_AUTHORITY_(?:REQUIRED|INVALID|MISMATCH))$/).safeParse(hasProperties(value) ? value.code : undefined);
      throw new SpaceError(code.success ? code.data : 'agent_transfer_failed', code.success ? code.data : 'agent_transfer_failed');
    }
    return value;
  };
  const request = async (input: TransferRequest, operation: string, { method = 'GET', body, extra }: TransferJsonOptions = {}) => {
    const requestOptions: AgentRequestOptions = { path: await route(input, operation, extra), method, timeoutMs: caps.timeoutMs };
    if (body !== undefined) Object.assign(requestOptions, { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    return transferValue(upstream || null).request(requestOptions);
  };
  const json = async <Schema extends z.ZodType>(input: TransferRequest, operation: string, options: TransferJsonOptions, schema: Schema): Promise<z.output<Schema>> => {
    const value = await responseJson(await request(input, operation, options));
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw bundleFailure('agent_metadata_invalid');
    return parsed.data;
  };
  const snapshot = async (input: TransferRequest, create: boolean) => {
    const record = create ? null : createSpaceRecords({ dataDir: transferValue(dataDir) }).read(input.spaceId).record;
    const base = input.base ?? (record?.repository === input.repository ? record.base : null);
    const response = await request(input, 'snapshot', create ? { method: 'POST', body: { mode: input.mode ?? 'uncommitted' } }
      : { extra: base ? { base } : {} });
    try {
      const metadata = parseSnapshotMetadata(await responseJson(response), input.spaceId);
      const source = sourceOf(input);
      const actual = metadata.source ?? { kind: 'project', directory: metadata.directory } as const;
      if (source.kind === 'bot-checkout' ? !sameTransferSource(actual, source)
        : actual.kind !== 'project' || actual.directory !== metadata.directory) throw bundleFailure('agent_source_mismatch');
      const trustedMigrationPath = await migrationPathOf(input);
      if (Boolean(metadata.trustedMigrationPath) !== Boolean(trustedMigrationPath)
        || trustedMigrationPath && !sameBotMigrationPath(metadata.trustedMigrationPath, trustedMigrationPath)) throw bundleFailure('agent_source_mismatch');
      return metadata;
    }
    catch (error) {
      if (create && response.statusCode === 200) {
        if (!hasFailureFields(error)) throw new TypeError(`Cannot read properties of ${error} (reading 'details')`);
        error.details = withTransferErrorDetails(error.details, { snapshotMayExist: true });
      }
      throw error;
    }
  };
  const withMirror = <Result>(input: TransferRequest, metadata: SnapshotMetadata, work: (context: TransferMirror) => Promise<Result>): Promise<Result> => withBundleDirectory({ ...options, caps,
    temporaryDirectory: options.temporaryDirectory ?? path.join(transferValue(dataDir), 'spaces', 'transfers') }, async ({ directory, git }) => {
    const name = path.basename(sourceOf(input).kind === 'bot-checkout' ? input.repository : metadata.repository);
    if (name === '' || name === '.' || name === '..') throw bundleFailure('agent_metadata_invalid');
    await fs.mkdir(path.join(directory, 'mirror'), { mode: 0o700 });
    const repository = path.join(directory, 'mirror', name);
    await git.output(directory, ['init', '--quiet', '--template=', `--object-format=${metadata.objectFormat}`, repository]);
    if (metadata.shallow.length) await fs.writeFile(path.join(repository, '.git/shallow'), `${metadata.shallow.join('\n')}\n`);
    const file = path.join(directory, 'start.bundle');
    const response = await request(input, 'bundle');
    if (response.statusCode !== 200) await responseJson(response);
    await receiveBundle(response, file, caps);
    await importBundle(git, repository, file, { caps, objectFormat: metadata.objectFormat, id: metadata.start, ref: metadata.ref });
    await checkSnapshotChain(git, repository, metadata);
    return work({ directory, git, repository, place, taken: { ...metadata, repository } });
  });
  return { caps, route, json, snapshot, withMirror, responseJson, sourceOf, migrationPathOf };
}

export function createAgentCodeIn(options: AgentCodeInOptions) {
  const remote = agentTransfer(options);
  const histories = new Map<string, Promise<HistoryResult>>();
  const removeSpaceRefs = async (input: TransferRequest) => {
    const refs = await remote.json(input, 'refs', { method: 'DELETE' }, z.array(z.string()).max(100));
    if (refs.some((ref) => !ref.startsWith(spaceRefPrefix(input.spaceId)))) throw bundleFailure('agent_metadata_invalid');
    return refs;
  };
  const bringCodeIn = async (input: BringRequest) => {
    let metadata: SnapshotMetadata | undefined;
    try {
      metadata = await remote.snapshot(input, true);
      return await remote.withMirror(input, metadata, ({ git, directory, taken }) => options.localCodeIn({ git, place: options.place,
        temporaryDirectory: directory, snapshotSource: async () => taken }).bringCodeIn(input));
    } catch (error) {
      const details = metadata ? undefined : requiredFailureProperty(error, 'details');
      if (metadata || hasProperties(details) && details.snapshotMayExist) {
        try { await removeSpaceRefs(input); }
        catch (cleanup) {
          if (!hasFailureFields(error)) throw new TypeError(`Cannot read properties of ${error} (reading 'details')`);
          error.details = withTransferErrorDetails(error.details, { refNotRemoved: `${spaceRefPrefix(input.spaceId)}start`, cleanupCode: requiredFailureProperty(cleanup, 'code') });
        }
      }
      throw error;
    }
  };
  const sendHistory = (input: HistoryRequest) => {
    const key = JSON.stringify([input.repository, input.spaceId, input.spacePath, input.base, remote.sourceOf(input)]);
    const existing = histories.get(key);
    if (existing) return existing;
    const promise = (async () => {
      const metadata = await remote.snapshot(input, false);
      if (metadata.base !== input.base) throw bundleFailure('agent_snapshot_changed');
      return remote.withMirror(input, metadata, ({ git, directory, repository }) => options.localCodeIn({ git,
        place: options.place, temporaryDirectory: directory }).sendHistory({ ...input, repository }));
    })().finally(() => histories.delete(key));
    histories.set(key, promise);
    return promise;
  };
  return { bringCodeIn, sendHistory, removeSpaceRefs,
    captureTransferSource: async (input: TransferSourceRequest): Promise<Pick<TransferOwner, 'trustedMigrationPath'>> => ({ trustedMigrationPath: await remote.migrationPathOf(input) }) };
}

export function createAgentCodeOut(options: AgentCodeOutOptions) {
  const remote = agentTransfer(options);
  const bringCodeOut = async (input: CodeOutRequest) => {
    const metadata = await remote.snapshot(input, false);
    return remote.withMirror(input, metadata, async ({ git, directory, repository }) => {
      const summary = await options.localCodeOut({ git, place: options.place, temporaryDirectory: directory })
        .bringCodeOut({ ...input, repository });
      const file = path.join(directory, 'result.bundle');
      await makeResultBundle(git, repository, file, { ...metadata, spaceId: input.spaceId, result: summary.result, caps: remote.caps });
      const size = (await fs.stat(file)).size;
      if (size > remote.caps.bundleBytes) throw bundleFailure('agent_bundle_too_large');
      const response = await transferValue(options.upstream || null).request({ path: await remote.route(input, 'result', { start: metadata.start, result: summary.result }),
        method: 'POST', body: createReadStream(file), headers: { 'content-type': 'application/x-git-bundle', 'content-length': String(size) },
        timeoutMs: remote.caps.timeoutMs });
      const parsed = summarySchema.safeParse(await remote.responseJson(response));
      if (!parsed.success || parsed.data.result !== summary.result) throw bundleFailure('agent_metadata_invalid');
      const result: CodeOutSummary & { association?: { spaceId: string; source: Extract<z.infer<typeof transferSourceSchema>, { kind: 'bot-checkout' }> } } = { ...summary };
      if (metadata.source?.kind === 'bot-checkout') result.association = { spaceId: input.spaceId, source: metadata.source };
      return result;
    });
  };
  return { bringCodeOut,
    describeApplyState: (input: ApplyRequest) => remote.json(input, 'apply-state', {}, stateSchema),
    applyAsBranch: (input: ApplyRequest & { branch: string }) => remote.json(input, 'apply-branch', { method: 'POST', body: { branch: input.branch } }, branchSchema),
    applyAsChanges: (input: ApplyRequest) => remote.json(input, 'apply-changes', { method: 'POST', body: {} }, changesSchema),
  };
}
