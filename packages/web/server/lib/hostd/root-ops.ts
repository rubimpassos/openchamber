import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { ROOT_EQUIVALENT_GROUPS } from '../host-install/accounts.js';
import { HOST_CONFIG_FILE } from '../host-install/managed.js';
import { SpaceError } from '../spaces/errors.js';
import { RootPasskeyError, activationSpecHash, createRootPasskeys } from './passkey.js';
import { ShareProjectError, createProjectSharing } from './share-project.js';
import type { RunCommand } from '../spaces/command-contracts.js';
import type { ParsedHostdRequest, HostdSpec } from './contracts.js';
import type { createState, StatePaths } from './state.js';
import type { createLifecycle } from './lifecycle.js';

const ROOT_PLACE = 'host-root';
type RootOperation = 'root-status' | 'root-approval-challenge' | 'root-approval-complete' | 'root-activation-options' | 'share-project' | 'unshare-project' | 'project-owner' | 'project-shares';
type RootRequest = Extract<ParsedHostdRequest, { readonly op: RootOperation }> | { readonly op: 'root-status' | 'project-shares' };
const ROOT_OPERATIONS: ReadonlySet<string> = new Set<RootOperation>(['root-status', 'root-approval-challenge', 'root-approval-complete', 'root-activation-options', 'share-project', 'unshare-project', 'project-owner', 'project-shares']);
export const isRootRequest = (request: ParsedHostdRequest): request is ParsedHostdRequest & RootRequest => ROOT_OPERATIONS.has(request.op);
const ACCOUNT_NAME = /^[a-z_][a-z0-9_-]{0,31}$/;
const hostConfigSchema = z.object({ owner: z.string(), separation: z.object({ frontDoor: z.string(), agent: z.string() }) });

const translated = async <Result>(work: () => Result | Promise<Result>): Promise<Result> => {
  try {
    return await work();
  } catch (error) {
    if (error instanceof RootPasskeyError || error instanceof ShareProjectError) {
      throw new SpaceError(error.code, error.message, 'details' in error ? error.details ?? null : null);
    }
    throw error;
  }
};

type Verify = Parameters<typeof createRootPasskeys>[0]['verify'];
const verifyWithSimpleWebAuthn: Verify = async (options) => (await import('@simplewebauthn/server')).verifyAuthenticationResponse(options);
type RootOpsOptions = {
  readonly paths: Pick<StatePaths, 'state'>;
  readonly state: Pick<ReturnType<typeof createState>, 'read' | 'requireRecord'>;
  readonly run: RunCommand;
  readonly configFile?: string;
  readonly verify?: Verify;
  readonly passkeys?: ReturnType<typeof createRootPasskeys> | null;
  readonly readMountInfo?: Parameters<typeof createProjectSharing>[0]['readMountInfo'] | undefined;
};
export function createRootOps({ paths, state, run, configFile = HOST_CONFIG_FILE, verify = verifyWithSimpleWebAuthn, passkeys = null, readMountInfo }: RootOpsOptions) {
  const store = passkeys ?? createRootPasskeys({
    stateFile: path.join(paths.state, 'root-passkeys.json'),
    pendingFile: path.join(paths.state, 'root-passkey-approval.json'),
    verify,
  });

  const account = async (name: string) => {
    if (!ACCOUNT_NAME.test(name)) return null;
    const result = await run('/usr/bin/getent', ['passwd', name]);
    if (result.code !== 0) return null;
    const [entry, , uid, gid, , home] = result.stdout.trim().split(':');
    if (entry !== name || !/^\d+$/.test(uid ?? '') || !/^\d+$/.test(gid ?? '') || !home || !path.isAbsolute(home)) return null;
    return { name, uid: Number(uid), gid: Number(gid), home };
  };

  const separation = async () => {
    let config;
    try {
      config = JSON.parse(await fs.readFile(configFile, 'utf8'));
    } catch {
      return null;
    }
    const named = hostConfigSchema.safeParse(config);
    if (!named.success) return null;
    const { owner, separation: { frontDoor, agent: agentName } } = named.data;
    const [human, front, agent] = await Promise.all([owner, frontDoor, agentName].map(account));
    if (!human || !front || !agent || new Set([0, human.uid, front.uid, agent.uid]).size !== 4) return null;
    for (const { name } of [front, agent]) {
      const groups = await run('/usr/bin/id', ['-Gn', '--', name]);
      if (groups.code !== 0 || groups.stdout.trim().split(/\s+/).some((group) => ROOT_EQUIVALENT_GROUPS.includes(group))) return null;
    }
    return { human, front, agent };
  };
  const requireSeparation = async () => {
    const accounts = await separation();
    if (!accounts) throw new SpaceError('agent_separation_missing', 'Root spaces and project sharing need OpenChamber installed with its agent on an account of its own (install --separation)');
    return accounts;
  };

  const status = async () => {
    const approved = await store.list();
    if (!await separation()) return { available: false, reason: 'agent_separation_missing', passkeys: approved };
    return { available: approved.length > 0, reason: approved.length > 0 ? null : 'no_passkey_approved', passkeys: approved };
  };

  const hashOf = (spec: Omit<HostdSpec, 'created'>) => activationSpecHash({ place: ROOT_PLACE, id: spec.id, name: spec.name, project: spec.project, purpose: spec.purpose ?? 'general', memoryBytes: spec.memoryBytes });
  const requireGeneral = (spec: Omit<HostdSpec, 'created'>) => {
    if ((spec.purpose ?? 'general') !== 'general') throw new SpaceError('root_place_not_allowed', 'An approval worker never runs as root');
  };

  const activationOptions = (request: Extract<RootRequest, { readonly op: 'root-activation-options' }>) => translated(async () => {
    await requireSeparation();
    let spec;
    if (request.action === 'create') {
      spec = request.spec;
      if (await state.read(spec.id)) throw new SpaceError('space_name_taken', 'This host space id is already in use');
    } else {
      spec = await state.requireRecord(ROOT_PLACE, request.id);
    }
    requireGeneral(spec);
    return store.activationOptions({ op: request.action, id: spec.id, specHash: hashOf(spec) });
  });

  const authorize: Parameters<typeof createLifecycle>[0]['authorizeRoot'] = ({ op, id, spec, assertion }) => translated(async () => {
    await requireSeparation();
    requireGeneral(spec);
    if (!assertion) throw new SpaceError('root_activation_required', 'A root space is created or started only with a passkey confirmation made for it');
    await store.verifyActivation({ op, id, specHash: hashOf(spec), response: assertion });
  });

  let sharing = Promise.resolve();
  const withSharing = <Result>(work: (projects: ReturnType<typeof createProjectSharing>) => Promise<Result>) => {
    const result = sharing.then(() => translated(async () => {
      const { human, agent } = await requireSeparation();
      const options: Parameters<typeof createProjectSharing>[0] = { human, agent, run, statePath: path.join(paths.state, 'shares.json') };
      return work(createProjectSharing(readMountInfo === undefined ? options : { ...options, readMountInfo }));
    }));
    sharing = result.then(() => undefined, () => undefined);
    return result;
  };

  const handle = (request: RootRequest) => {
    switch (request.op) {
      case 'root-status': return status();
      case 'root-approval-challenge': return translated(() => store.approvalChallenge({ code: request.code }));
      case 'root-approval-complete': return translated(() => store.completeApproval(request));
      case 'root-activation-options': return activationOptions(request);
      case 'share-project': return withSharing((projects) => projects.share(request.path));
      case 'unshare-project': return withSharing((projects) => projects.unshare(request.path));
      case 'project-owner': return withSharing(async (projects) => ({ owner: await projects.ownerOf(request.path) }));
      case 'project-shares': return withSharing((projects) => projects.list());
      default: throw new SpaceError('invalid_request', 'Unknown hostd operation');
    }
  };

  return { handle, authorize, status, separation };
}
