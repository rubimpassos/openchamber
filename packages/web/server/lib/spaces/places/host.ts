import { fileURLToPath } from 'node:url';
import type { Duplex } from 'node:stream';
import { z } from 'zod';
import { createHostdClient, DEFAULT_SOCKET } from '../../hostd/client.js';
import type { HostdRequest, HostdRequestOptions, HostdPlace, HostdSpec } from '../../hostd/contracts.js';
import { helperSpawnEnv } from '../../git/helper-launch.js';
import { SpaceError } from '../errors.js';
import { requiredFailureProperty } from '../failure.js';
import { requireSpaceId } from '../resource-ids.js';
import { buildFillInput } from '../tools-filler.js';
import { requireToolsSource, toolsContentKey } from '../tools.js';
import type { ToolsSource } from '../tools.js';
import type { SpaceSpec } from '../manager.js';
import type { CommandOptions } from '../command-contracts.js';

type ActivationRequest = { readonly place: HostdPlace; readonly assertion?: unknown } & (
  | { readonly op: 'create'; readonly spec: SpaceSpec; readonly startConfig: string | null; readonly toolsKey: string | null }
  | { readonly op: 'start'; readonly id: string }
);
type HostClient = {
  readonly socketPath?: string;
  request(request: HostdRequest | ActivationRequest, options?: HostdRequestOptions): ReturnType<ReturnType<typeof createHostdClient>['request']>;
  readonly exec: ReturnType<typeof createHostdClient>['exec'];
  attach(request: Parameters<ReturnType<typeof createHostdClient>['attach']>[0]): Promise<Duplex>;
};
type HostPlaceOptions = {
  readonly id?: string;
  readonly hostd?: HostClient;
  readonly toolsSource: ToolsSource;
  readonly clientScript?: string;
  readonly helperRuntime?: { readonly execPath: string; readonly versions: NonNullable<Parameters<typeof helperSpawnEnv>[1]>['versions'] };
};
type CreateOptions = { readonly onStep?: ((step: string) => void) | undefined; readonly startConfig?: string | null; readonly activation?: unknown };
type StartOptions = { readonly activation?: unknown };
type ActivationOptions = { readonly op: 'create'; readonly spec: Omit<HostdSpec, 'created'> } | { readonly op: 'start'; readonly id: string };

const availabilitySchema = z.discriminatedUnion('available', [
  z.looseObject({ available: z.literal(true), nodeVersion: z.string(), version: z.string(), os: z.string(), arch: z.string(), hostIsolation: z.boolean() }),
  z.looseObject({ available: z.literal(false), code: z.string(), message: z.string() }),
]);
const spacesSchema = z.array(z.looseObject({
  id: z.string(), name: z.string(), project: z.string(), created: z.string(), state: z.enum(['running', 'exited', 'missing']),
  purpose: z.string().optional(), orphans: z.array(z.looseObject({ kind: z.enum(['container', 'network', 'volume', 'image']), name: z.string() })),
  damaged: z.boolean(), missing: z.array(z.string()), stoppedIdle: z.boolean(), gatekeeperRunning: z.boolean(),
}));
const diskSchema = z.looseObject({
  toolsBytes: z.number(), imageBytes: z.number(), spacesBytes: z.number(), bytesBySpace: z.record(z.string(), z.number()),
  freeBytes: z.number(), freesImage: z.boolean(),
});
const removalSchema = z.looseObject({
  removed: z.array(z.looseObject({ kind: z.string(), name: z.string() })),
  failed: z.array(z.looseObject({ kind: z.string(), name: z.string(), message: z.string().optional() })),
});
const violationsSchema = z.array(z.looseObject({ check: z.string(), message: z.string() }));
const toolsSchema = z.looseObject({ key: z.string(), filled: z.boolean() });
const passkeySummarySchema = z.looseObject({ id: z.string(), label: z.string(), rpID: z.string(), origin: z.string(), approvedAt: z.number(), fingerprint: z.string() });
const approvalChallengeSchema = z.looseObject({ challenge: z.string() });
const rootStatusSchema = z.looseObject({ available: z.boolean(), reason: z.string().nullable(), passkeys: z.array(passkeySummarySchema) });
const rootActivationSchema = approvalChallengeSchema.extend({ expiresAt: z.number(), credentials: z.array(passkeySummarySchema) });
const rootApprovalSchema = z.looseObject({ awaitingConfirmation: z.literal(true), fingerprint: z.string(), label: z.string(), origin: z.string() });

export function createHostPlace({ id = 'host', hostd = createHostdClient(), toolsSource, clientScript = fileURLToPath(new URL('../../hostd/attach-client.js', import.meta.url)), helperRuntime = { execPath: process.execPath, versions: process.versions } }: HostPlaceOptions) {
  if (id !== 'host' && id !== 'host-root') throw new SpaceError('invalid_place', 'A host place is host or host-root');
  const source = requireToolsSource(toolsSource);
  const check = async () => {
    try {
      const result = availabilitySchema.parse(await hostd.request({ op: 'check' }));
      return result.available && id === 'host-root' ? { ...result, hostIsolation: false } : result;
    }
    catch (error) {
      const code = requiredFailureProperty(error, 'code');
      if (code === 'hostd_missing' || code === 'hostd_unreachable' || code === 'hostd_timeout' || code === 'hostd_disconnected') return { available: false as const, code, message: z.string().parse(requiredFailureProperty(error, 'message')) };
      throw error;
    }
  };
  let filling: Promise<z.infer<typeof toolsSchema>> | null = null;
  let failure: { code: unknown; message: unknown } | null = null;
  let key: string | null = null;
  const ensure = () => {
    filling ??= (async () => {
      const availability = await check();
      if (!availability.available) throw new SpaceError(availability.code, availability.message);
      key = toolsContentKey(source, `host:${availability.nodeVersion}:${availability.arch}`);
      const input = buildFillInput({ key, packageJson: source.packageJson, files: source.files });
      const result = toolsSchema.parse(await hostd.request({ op: 'tools-ensure', key, input: null }, { input }));
      failure = null;
      return result;
    })().catch((error) => { failure = { code: requiredFailureProperty(error, 'code'), message: requiredFailureProperty(error, 'message') }; throw error; }).finally(() => { filling = null; });
    return filling;
  };
  const list = async () => spacesSchema.parse(await hostd.request({ op: 'list', place: id }))
    .map(({ purpose, ...space }) => purpose === undefined ? space : { ...space, purpose });
  const requireRunning = async (spaceId: string) => {
    const entry = (await list()).find((space) => space.id === requireSpaceId(spaceId));
    if (!entry) throw new SpaceError('space_not_found', `There is no space ${spaceId} on ${id}`);
    if (entry.state !== 'running') throw new SpaceError('space_not_running', `Space ${spaceId} is stopped`);
  };
  const exec = (spaceId: string, argv: string[], options: CommandOptions & { readonly target?: string } = {}) => {
    const target = options.target ?? 'space';
    if (target !== 'space' && target !== 'gatekeeper') return Promise.reject(new SpaceError('invalid_exec_target', 'A command runs in the space or gatekeeper'));
    return hostd.exec({ op: 'exec', place: id, id: requireSpaceId(spaceId), target, argv,
      timeoutMs: options.timeoutMs ?? 60_000, maxOutputBytes: options.maxOutputBytes ?? 4 * 1024 * 1024, keepTail: options.keepTail === true }, options);
  };
  const execArgv = async (spaceId: string) => {
    await requireRunning(spaceId);
    const socketArgs = hostd.socketPath && hostd.socketPath !== DEFAULT_SOCKET ? ['--socket', hostd.socketPath] : [];
    const environment = Object.entries(helperSpawnEnv({}, helperRuntime)).map(([key, value]) => `${key}=${value}`);
    const argv = [...(environment.length ? ['/usr/bin/env', ...environment] : []), helperRuntime.execPath, clientScript, ...socketArgs, 'attach', id, spaceId];
    if (argv.some((argument) => !argument || [...argument].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    }))) throw new SpaceError('invalid_command', 'The host attach client path is not safe for git transport');
    return argv;
  };
  const place = {
    id, kind: id, machine: null, check, list, exec, execArgv,
    requireWindowUpstream: (upstream: string) => {
      const hostname = new URL(upstream).hostname.toLowerCase().replace(/\.$/, '');
      if (['localhost', '[::1]', '0.0.0.0', 'host.docker.internal', 'gateway.docker.internal'].includes(hostname) || /^127\./.test(hostname) || /^\[::ffff:7f[0-9a-f]{2}:/.test(hostname)) {
        throw new SpaceError('host_loopback_unavailable', 'Host spaces cannot reach a provider on this machine\'s loopback. Give the provider a reachable network address, then grant it again.');
      }
    },
    create: async (spec: SpaceSpec, { onStep = () => {}, startConfig = null, activation = null }: CreateOptions = {}) => {
      onStep('preparing_tools'); await ensure(); onStep('creating');
      const creation = { op: 'create', place: id, spec, startConfig, toolsKey: key } as const;
      if (activation) { await hostd.request({ ...creation, assertion: activation }); return; }
      await hostd.request(creation);
    },
    start: async (spaceId: string, { activation = null }: StartOptions = {}) => {
      await ensure();
      const starting = { op: 'start', place: id, id: requireSpaceId(spaceId) } as const;
      if (activation) { await hostd.request({ ...starting, assertion: activation }); return; }
      await hostd.request(starting);
    },
    stop: async (spaceId: string) => z.null().parse(await hostd.request({ op: 'stop', place: id, id: requireSpaceId(spaceId) })),
    remove: async (spaceId: string) => removalSchema.parse(await hostd.request({ op: 'remove', place: id, id: requireSpaceId(spaceId) })),
    verify: async (spaceId: string) => violationsSchema.parse(await hostd.request({ op: 'verify', place: id, id: requireSpaceId(spaceId) })),
    connect: async (spaceId: string) => { await requireRunning(spaceId); const stream = await hostd.attach({ op: 'attach', place: id, id: spaceId }); return Object.assign(stream, { bridge: true }); },
    pullImage: ensure, imagePulling: () => filling !== null,
    readDisk: async () => ({ ...diskSchema.parse(await hostd.request({ op: 'disk', place: id })), imagePulling: filling !== null, imageFailure: failure }),
    cleanUpDisk: async () => {
      const before = diskSchema.parse(await hostd.request({ op: 'disk', place: id }));
      const result = removalSchema.parse(await hostd.request({ op: 'tools-prune', keep: key === null ? [] : [key] }));
      const after = diskSchema.parse(await hostd.request({ op: 'disk', place: id }));
      return { freedBytes: Math.max(0, before.toolsBytes - after.toolsBytes), kept: result.failed, machine: { state: 'skipped' } };
    },
  };
  if (id !== 'host-root') return place;
  return {
    ...place,
    rootStatus: async () => rootStatusSchema.parse(await hostd.request({ op: 'root-status' })),
    rootApprovalChallenge: async (code: string) => approvalChallengeSchema.parse(await hostd.request({ op: 'root-approval-challenge', code })),
    rootApprovalComplete: async (proof: Omit<Extract<HostdRequest, { op: 'root-approval-complete' }>, 'op'>) => rootApprovalSchema.parse(await hostd.request({ op: 'root-approval-complete', ...proof })),
    rootActivationOptions: async (options: ActivationOptions) => rootActivationSchema.parse(await hostd.request(options.op === 'create'
      ? { op: 'root-activation-options', action: 'create', spec: options.spec }
      : { op: 'root-activation-options', action: 'start', id: requireSpaceId(options.id) })),
  };
}
