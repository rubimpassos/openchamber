// The journey of a space as the host drives it: made with its network choice and the project's
// code, listed with its state, started again with its network said again to a gatekeeper that
// forgot it, stopped, removed with everything the host kept for it, its journal read, and its
// work brought out and applied. Everything here is written once on top of the manager, the
// gatekeeper channel, code in and code out; the routes in `routes.js` only translate HTTP.
//
// A creation runs in the background: the request comes back at once with the space's id, and the
// steps are announced as `openchamber:space-progress` events on the host's hub, so the group in
// the sidebar can say what is happening now (journey step 2). A creation that fails
// after the containers exist removes them again, and its failure stays listed until the user
// dismisses it, so an error is never silent.
//
// Grants, since 5b: a model key the gatekeeper's window adds to the provider's requests, or an
// opened domain the window forwards to with no credential. The host keeps the grant without its
// value (decision 5) and says it again to the gatekeeper after every start; a value it cannot
// find again leaves the space "needs access" until the user grants once more. Since stage 7 a
// grant can be the host's own browser login for a provider: the short token goes to the window
// the same way, read from the host's OpenCode now and at every start, and the space gets a row
// that only names the method (decision 13).
//
// Repair, since 5d-2 (journey step 8 and decision 10): restart OpenCode inside, and
// restart the container with a fresh token for the server inside. A space whose gatekeeper is gone
// is listed as such, because no restart brings it back.
//
// Idle stop, since 5d-3 (decision 11): the server inside stops itself after the user's idle hours.
// The host tells it the setting at every start and whenever the user changes it, lists a space
// that stopped that way as such, and stops the gatekeeper it finds running beside a stopped space,
// which is what an idle stop leaves while OpenChamber is closed. The permission mode a new chat
// starts in travels the same way, see `space-permission-default.js`.
//
// Setup commands, since 5d-4 (see "Setup commands" in DOCUMENTATION.md): the project's worktree setup commands
// run inside the space once its code arrived, in the background, and again when the user asks.
//
// The chat archive, since 5e-2 (decision 9, journey step 7): a delete takes the space's chats to
// the host's archive first, starting a stopped space for it, and deletes nothing when they cannot
// all be saved, unless the user said to delete anyway. See `space-archive.js`.
//
// Places on this computer's own users, `host` and `host-root`, since 2026-11: a space there can be
// given protected MCP connections, which its own subject of the protected MCP service carries, and
// a `host-root` space is made and started only with a passkey confirmation made for exactly that
// operation on exactly that space, which the root component checks before anything runs.

import crypto from 'node:crypto';
import fsPromises from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { approvalModelSchema, approvalPolicy, requireApprovalModel, requireApprovalModelWindow, requireProfileGrants, requireProfileNetwork, spacePurposeSchema } from './approval-profile.js';
import { SpaceError, spaceErrorProperty } from './errors.js';
import { transferErrorProperty, transferValue } from './code-transfer.js';
import { DEFAULT_IDLE_STOP, idleStopSchema } from './idle-stop.js';
import { headerOfProvider, windowUpstreamOf } from './host-providers.js';
import { createModelGrants, isProviderKnownByName, isSecretString } from './model-grants.js';
import { permissionDefaultOf } from './space-permission-default.js';
import { ROLE_GATEKEEPER, createSpaceId, hashProjectDirectory, spaceResourceName } from './labels.js';
import { spaceProjectPath, spaceWindowUrl } from './layout.js';
import { activationSpecOf } from './manager.js';
import { LOGIN_PROVIDERS, buildStartConfig, loginEndOf, loginEnded, loginGrantOf } from './space-opencode.js';
import { domainSchema, grantSchema, mcpConnectionSchema, mcpNameSchema, networkSchema, providerIdSchema, secretSourceSchema } from './space-records.js';
import { createSpaceToken } from './space-server.js';
import { createSpaceSetup, setupCommandsSchema } from './space-setup.js';
import { botMigrationPathSchema, transferSourceSchema } from './transfer-bundle.js';
import type { StoredLogin } from '../opencode/auth.js';
import type { createSpaceManager } from './manager.js';
import type { createDockerPlace } from './places/docker.js';
import type { createPlaceRegistry } from './places/registry.js';
import type { createGatekeeperChannel, GatekeeperGrant } from './gatekeeper-channel.js';
import type { createCodeIn } from './code-in.js';
import type { createCodeOut } from './code-out.js';
import type { createSpaceRecords } from './space-records.js';
import type { createSpaceOpenCode } from './space-opencode.js';
import type { createSpaceServerChannel } from './space-server.js';
import type { HostProviderDefinition, HostProviders } from './host-providers.js';
import type { createHostCatalog } from './host-catalog.js';
import type { SpaceRecord, SpaceGrant as Grant, SpaceNetwork as Network } from './space-records.js';
import type { createHostPlace } from './places/host.js';
import type { McpSubjectResult, McpSubjects, InternalCreation, RootActivationRequest, ApprovalCredential } from './journey-contracts.js';
export type { McpSubjectResult, McpSubjects, InternalCreation, ApprovalCredential } from './journey-contracts.js';

type TransferSource = z.infer<typeof transferSourceSchema>;
type MigrationPath = z.infer<typeof botMigrationPathSchema>;
type SpacePurpose = z.infer<typeof spacePurposeSchema>;
type ApprovalModel = z.infer<typeof approvalModelSchema>;
type RootActivation = z.infer<typeof rootActivationSchema>;
type JourneyPlace = ReturnType<typeof createDockerPlace> | ReturnType<typeof createHostPlace>;

type LoginGrant = Extract<Grant, { kind: 'login' }>;
type IdleStop = z.infer<typeof idleStopSchema>;
type PermissionDefault = ReturnType<typeof permissionDefaultOf>;
type SpaceManager = ReturnType<typeof createSpaceManager>;
type ListedSpace = Awaited<ReturnType<SpaceManager['listAllSpaces']>>['spaces'][number];
type CustomDefinition = HostProviderDefinition;
type PlaceCheck = Awaited<ReturnType<ReturnType<typeof createDockerPlace>['check']>>;
const placeAnsweredAvailable = (check: PlaceCheck): check is Extract<PlaceCheck, { hostIsolation: boolean }> => check.available;
const grantProvider = (grant: Grant) => 'provider' in grant ? grant.provider : undefined;

export interface JourneyFailure {
  code: unknown;
  message: unknown;
  details: unknown;
  cleanup?: JourneyFailure[];
}

interface PendingSpace {
  id: string;
  name: string;
  placeId: string | undefined;
  projectDirectory: string;
  directory: string;
  created: string;
  state: string;
  step: string;
  failure: JourneyFailure | null;
  network: Network;
  setupTotal: number;
  identityCopied?: { name: boolean; email: boolean };
  sourceDirectory: string;
  source: TransferSource | undefined;
  trustedMigrationPath: MigrationPath | undefined;
  purpose: SpacePurpose;
  approvalModel: ApprovalModel | null;
}

export interface SpaceJourneyOptions<HostSecret, ArchivedChats> {
  manager: SpaceManager;
  places: ReturnType<typeof createPlaceRegistry<JourneyPlace>>;
  gatekeeper: ReturnType<typeof createGatekeeperChannel>;
  codeIn: ReturnType<typeof createCodeIn>;
  codeOut: ReturnType<typeof createCodeOut>;
  records: ReturnType<typeof createSpaceRecords>;
  spaceOpenCode: ReturnType<typeof createSpaceOpenCode>;
  serverInside: ReturnType<typeof createSpaceServerChannel>;
  restartOpenCodeInside: (spaceId: string) => Promise<void>;
  listProjectDirectories: () => Promise<string[]>;
  archiveChats?: ((request: { spaceId: string; name: ListedSpace['name']; projectDirectory: string | null; running: boolean; allowUnsaved: boolean }) => Promise<ArchivedChats>) | null;
  readHostSecret?: (name: string) => HostSecret | undefined | Promise<HostSecret | undefined>;
  mcpSubjects?: McpSubjects;
  readHostLogin?: (provider: string) => Promise<StoredLogin | null>;
  loginWindowOf?: typeof loginGrantOf | undefined;
  hostProviders?: HostProviders;
  hostCatalog?: ReturnType<typeof createHostCatalog>;
  readIdleStop?: (() => Promise<IdleStop>) | undefined;
  saveIdleStop?: ((setting: IdleStop) => Promise<void | object>) | undefined;
  readPermissionDefault?: (() => Promise<PermissionDefault>) | undefined;
  folderExists?: ((directory: string) => Promise<boolean | null>) | undefined;
  resolveDirectory?: typeof path.resolve;
  announce?: (spaceId: string, payload: { type: string; properties: object }) => void;
  onSpacesChanged?: () => void;
  logger?: Pick<Console, 'warn'> & Partial<Pick<Console, 'info'>>;
  now?: () => Date;
}

const errorSummary = <Cause>(error: Cause) => spaceErrorProperty(error, 'code') ?? spaceErrorProperty(error, 'message') ?? error;

const createRequestSchema = z.object({
  purpose: spacePurposeSchema.default('general'),
  approvalModel: approvalModelSchema.nullable().default(null),
  // The place the space is made on; the first configured place unless the dialog says another. On
  // Linux that is the isolated host user (`host.js` registers it first), elsewhere local Docker.
  placeId: z.string().min(1).optional(),
  projectDirectory: z.string().min(1),
  name: z.string().trim().min(1),
  start: z.enum(['clean', 'uncommitted']).default('uncommitted'),
  network: networkSchema.default({ mode: 'allowlist', domains: [] }),
  setupCommands: setupCommandsSchema.default([]),
  grants: z.lazy(() => creationGrantsSchema).default([]),
  // A root place only: the id the passkey confirmation was asked for, and the confirmation itself.
  spaceId: z.string().regex(/^[0-9a-f]{12}$/).optional(),
  rootActivation: z.lazy(() => rootActivationSchema).optional(),
});
// A WebAuthn assertion as the browser hands it over, bounded here and checked by the root component.
const rootActivationSchema = z.object({
  id: z.string().min(1).max(2048),
  rawId: z.string().min(1).max(2048),
  type: z.literal('public-key'),
  response: z.object({
    clientDataJSON: z.string().min(1).max(16_384),
    authenticatorData: z.string().min(1).max(16_384),
    signature: z.string().min(1).max(4096),
    userHandle: z.string().max(1024).optional(),
  }).strict(),
  clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
  authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
}).strict();
const rootApprovalCodeSchema = z.object({ code: z.string().min(1).max(16) }).strict();
const rootApprovalSchema = rootApprovalCodeSchema.extend({ response: rootActivationSchema, label: z.string().max(120).optional() }).strict();
// The root component cannot be asked: not installed, not running, or gone during the request.
const HOSTD_UNAVAILABLE = new Set(['hostd_missing', 'hostd_unreachable', 'hostd_timeout', 'hostd_disconnected']);
// A Windows path names its drive in either case; a POSIX path never starts with a letter and a colon.
const withUpperDrive = (directory: string) => directory.replace(/^[a-z]:/, (drive) => drive.toUpperCase());
const projectDirectoryOf = (record: SpaceRecord | null) => record?.source?.kind === 'bot-checkout' ? record.source.projectDirectory : record?.repository ?? null;

type CreationRefusal = [string, string];
interface CreationRefusals {
  [field: string]: CreationRefusal | undefined;
  [field: symbol]: CreationRefusal | undefined;
  placeId: CreationRefusal;
  projectDirectory: CreationRefusal;
  name: CreationRefusal;
  start: CreationRefusal;
  network: CreationRefusal;
  setupCommands: CreationRefusal;
  grants: CreationRefusal;
  purpose: CreationRefusal;
  approvalModel: CreationRefusal;
  spaceId: CreationRefusal;
  rootActivation: CreationRefusal;
}
const CREATE_REFUSALS: CreationRefusals = {
  purpose: ['invalid_space_purpose', 'Choose general or pr-fix-loop-approval when creating a new space.'],
  approvalModel: ['space_approval_model_unreviewed', 'An approval worker needs a reviewed providerID and modelID selected by the host.'],
  placeId: ['place_not_found', 'A space is made on one of the configured places.'],
  projectDirectory: ['project_not_registered', 'A space is made for a project this OpenChamber knows. Add the project first, then create the space.'],
  name: ['invalid_space_name', 'A space needs a name.'],
  start: ['invalid_snapshot_mode', 'A space starts from a clean commit or with the uncommitted changes.'],
  network: ['invalid_network', 'The network of a space is allowlist or open, with a list of domain names for the allowlist.'],
  setupCommands: ['invalid_setup_commands', 'The setup commands are a list of at most 100 commands of at most 4000 characters each.'],
  grants: ['invalid_grant_request', 'The model access of a new space is a list of model keys, the host\'s own logins and providers of your own.'],
  spaceId: ['invalid_space_id', 'A space id is 12 lowercase hex characters.'],
  rootActivation: ['root_activation_invalid', 'The passkey confirmation is not one a browser makes.'],
};
const setupRequestSchema = z.object({ commands: setupCommandsSchema }).strict();
const MAX_SECRET_LENGTH = 8192;
const grantRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('model'),
    provider: grantSchema.options[0]['shape'].provider,
    upstream: grantSchema.options[0]['shape'].upstream.optional(),
    secret: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('typed'), value: z.string().min(1).max(MAX_SECRET_LENGTH) }).strict(),
      secretSourceSchema.options[0],
      z.object({ kind: z.literal('stored') }).strict(),
    ]),
  }).strict(),
  z.object({ kind: z.literal('domain'), upstream: grantSchema.options[1]['shape'].upstream }).strict(),
  z.object({ kind: z.literal('login'), provider: providerIdSchema }).strict(),
  z.object({ kind: z.literal('custom'), provider: providerIdSchema }).strict(),
  // A protected MCP connection under the name OpenCode inside knows it by; this computer's places only.
  z.object({ kind: z.literal('mcp'), connection: mcpConnectionSchema, name: mcpNameSchema }).strict(),
]);
// The places on this computer's own users, where the protected MCP service is reachable at all.
const HOST_PLACE_KINDS = new Set(['host', 'host-root']);
const ROOT_PLACE_KIND = 'host-root';
const mcpSubjectOf = (spaceId: string) => `space-${spaceId}`;
// The model access a creation may carry: the grant dialog's kinds without the opened domain,
// which the network choice already covers, one per provider.
const MAX_CREATION_GRANTS = 16;
export type GrantRequest = z.infer<typeof grantRequestSchema>;
const creationGrantsSchema = z.array(z.discriminatedUnion('kind', [
  grantRequestSchema.options[0],
  grantRequestSchema.options[2],
  grantRequestSchema.options[3],
])).max(MAX_CREATION_GRANTS);

const openDomainRequestSchema = z.object({
  domain: z.string().trim().toLowerCase().pipe(domainSchema),
}).strict();

const applyRequestSchema = z.discriminatedUnion('as', [
  z.object({ as: z.literal('branch'), branch: z.string(), removeAfterwards: z.boolean().default(false) }),
  z.object({ as: z.literal('changes'), removeAfterwards: z.boolean().default(false) }),
]);

const REPAIR_BUSY_ATTEMPTS = 40;
const REPAIR_BUSY_PAUSE_MS = 250;
const pause = (milliseconds: number) => new Promise<void>((resolve) => { setTimeout(resolve, milliseconds); });

const failureOf = <Cause>(error: Cause): JourneyFailure => ({
  code: error instanceof SpaceError ? error.code : 'space_journey_failed',
  message: spaceErrorProperty(error, 'message') ?? String(error),
  details: error instanceof SpaceError ? error.details ?? null : null,
});

/**
 * `manager` is the space manager over every place, which routes a space's operations to the place
 * it lives on, and `places` the place registry, asked by id for a check, the disk and the image.
 * `listProjectDirectories` answers the host's registered projects; a space is made for one of them
 * and its label carries the project's hash. `announce(spaceId, payload)` enters an event into the
 * host's hub, `onSpacesChanged()` tells the host to read its list again at once. `spaceOpenCode`
 * writes OpenCode's files inside a space, and `readHostSecret(name)` is how a key named by an
 * environment variable of the host's is found again: its value or undefined, never stored.
 * `readHostLogin(provider)` reads the host's own browser login for a provider from its OpenCode,
 * `{ methodID, access, expires, metadata }` or null, for a login grant; it is never stored either.
 * `loginWindowOf(provider, login)` is the window grant that login makes, `space-opencode.js`'s
 * unless a live test points the upstream at a stand-in. `hostProviders` reads the providers the
 * user defined in the host's OpenCode configuration, `host-providers.js`, for a custom grant:
 * `read(providerId, directory)` one with its key, `list(directory)` all of them without.
 * `serverInside.writeToken(spaceId, token)` replaces the token the server inside reads when it
 * starts, and `restartOpenCodeInside(spaceId)` asks the server inside to restart its OpenCode.
 * `readIdleStop()` and `saveIdleStop(setting)` read and keep the user's idle stop setting, and
 * `serverInside.writeIdleStop(spaceId, setting)` tells it to the server inside.
 * `readPermissionDefault()` reads the permission mode a new chat starts in, `{ mode }`, from the
 * host's settings, and `serverInside.writePermissionDefault(spaceId, setting)` tells it to the server inside.
 * `archiveChats({ spaceId, name, projectDirectory, running, allowUnsaved })` saves a space's chats
 * to the host's archive before it goes, see `space-archive.js`; without it the chats go with it.
 * `folderExists(directory)` says whether the project folder a space was made for is still a
 * folder on the host, for the list. `resolveDirectory` is the host's `path.resolve`, injectable so a
 * test can resolve Windows paths on another system. `mcpSubjects` changes the protected MCP
 * service's subjects through its admin socket: `set(subject, connections)` and `remove(subject)`,
 * each resolving `{ ok: true }` or `{ ok: false, code }`; without the service both answer
 * `protected_mcp_unavailable`.
 */
interface SpaceRemoval {
  removed: boolean;
  refsRemoved: boolean | null;
  failures: JourneyFailure[];
}
interface RestoredGrants {
  restored: string[];
  needsAccess: string[];
}

export function createSpaceJourney<HostSecret, ArchivedChats>({
  manager,
  places,
  gatekeeper,
  codeIn,
  codeOut,
  records,
  spaceOpenCode,
  serverInside,
  restartOpenCodeInside,
  listProjectDirectories,
  mcpSubjects = { set: async () => ({ ok: false, code: 'protected_mcp_unavailable' }), remove: async () => ({ ok: false, code: 'protected_mcp_unavailable' }) },
  archiveChats = null,
  readHostSecret = () => undefined,
  readHostLogin = async () => null,
  loginWindowOf = loginGrantOf,
  hostProviders = { read: async () => null, list: async () => [] },
  hostCatalog = { read: async () => null, list: async () => [], readStoredKey: async () => null },
  readIdleStop = async () => ({ ...DEFAULT_IDLE_STOP }),
  saveIdleStop = async () => {},
  readPermissionDefault = async () => permissionDefaultOf(null),
  folderExists = async (directory) => (await fsPromises.stat(directory).catch(() => null))?.isDirectory() === true,
  resolveDirectory = path.resolve,
  announce = () => {},
  onSpacesChanged = () => {},
  logger = console,
  now = () => new Date(),
}: SpaceJourneyOptions<HostSecret, ArchivedChats>) {
  const modelGrants = createModelGrants({ hostCatalog, readHostSecret });
  const pending = new Map<string, PendingSpace>();
  const creationAccessFailures = new Map<string, (JourneyFailure & { provider: string })[]>();
  const busy = new Set<string>();
  let closing = false;
  let settingsTurn: Promise<unknown> = Promise.resolve();
  const strayStops = new Map<string, Promise<void>>();
  const rowRepairs = new Map<string, Promise<void>>();
  const setup = createSpaceSetup({
    exec: manager.exec,
    records,
    announce: (spaceId) => announce(spaceId, { type: 'openchamber:space-setup', properties: { spaceId, timestamp: now().getTime() } }),
    logger,
    now,
  });

  const requirePlace = (placeId: string | undefined) => {
    const place = places.get(placeId);
    if (!place) throw new SpaceError('place_not_found', `There is no place ${placeId}`);
    return place;
  };
  /** What kind of place a place id names: Docker unless the place says otherwise, and for a place that is gone. */
  const placeKindOf = (placeId: string | undefined) => {
    const place = places.get(placeId);
    return place && 'kind' in place ? place.kind : 'docker';
  };
  const placeKindOfSpace = (spaceId: string) => placeKindOf(records.read(spaceId).record?.placeId ?? pending.get(spaceId)?.placeId);

  /**
   * Gives the space's own protected MCP subject exactly the connections of its MCP grants, before
   * a start, so the folder of its socket exists when the place binds it, and after every grant.
   * Resolves the service's answer; the caller decides whether a failure stops it.
   */
  const syncMcpSubject = async (spaceId: string, grants: Grant[]): Promise<McpSubjectResult> => {
    const connections = [...new Set(grants.flatMap((grant) => grant.kind === 'mcp' ? [grant.connection] : []))].sort();
    try {
      return await mcpSubjects.set(mcpSubjectOf(spaceId), connections);
    } catch (error) {
      const code = spaceErrorProperty(error, 'code');
      return { ok: false, code: typeof code === 'string' ? code : 'protected_mcp_unavailable' };
    }
  };
  /**
   * The same before a creation or a start, where a service that cannot be asked must not stop the
   * space: MCP grants then fail with its code. A host without the service is no news for a space
   * that has no MCP grant, so only the other failures are logged.
   */
  const prepareMcpSubject = async (spaceId: string, grants: Grant[]) => {
    if (!HOST_PLACE_KINDS.has(placeKindOfSpace(spaceId))) return;
    const answer = await syncMcpSubject(spaceId, grants);
    if (!answer.ok && (answer.code !== 'protected_mcp_unavailable' || grants.some((grant) => grant.kind === 'mcp'))) {
      logger.warn?.(`[spaces] the protected MCP subject of space ${spaceId} was not prepared: ${answer.code}`);
    }
  };

  let unavailablePlaces = '';
  const listAll = async () => {
    const listed = await manager.listAllSpaces();
    const names = listed.unavailable.map((entry) => entry.placeId).sort().join(',');
    if (names !== unavailablePlaces) {
      for (const { placeId, failure } of listed.unavailable) logger.warn?.(`[spaces] place ${placeId} cannot be asked, its spaces are listed from the records: ${errorSummary(failure)}`);
      if (names === '') logger.info?.('[spaces] every place answers again');
      unavailablePlaces = names;
    }
    return listed;
  };

  const exclusive = async <Result>(spaceId: string, work: () => Promise<Result>) => {
    if (busy.has(spaceId)) throw new SpaceError('space_busy', 'Another action on this space is still running. Wait for it to finish.');
    busy.add(spaceId);
    try {
      return await work();
    } finally {
      busy.delete(spaceId);
    }
  };

  const requireNotPending = (spaceId: string) => {
    const waiting = pending.get(spaceId);
    if (!waiting) return;
    if (waiting.state === 'failed') throw new SpaceError('space_creation_failed', 'Making this space failed. Dismiss it, then create a new one.');
    throw new SpaceError('space_preparing', 'This space is still being made.');
  };

  const registeredProjects = async () => {
    const directories = await listProjectDirectories();
    return new Map(directories.map((directory) => [hashProjectDirectory(directory), directory]));
  };

  const requireRegisteredProject = async (directory: string) => {
    const resolved = withUpperDrive(resolveDirectory(directory));
    const registered = (await listProjectDirectories()).find((candidate) => withUpperDrive(candidate) === resolved);
    if (registered === undefined) throw new SpaceError(...CREATE_REFUSALS.projectDirectory);
    return registered;
  };

  const progress = (entry: PendingSpace, step: string, failure: JourneyFailure | null = null) => {
    entry.step = step;
    entry.state = step === 'failed' ? 'failed' : step === 'ready' ? 'running' : 'preparing';
    entry.failure = failure;
    announce(entry.id, { type: 'openchamber:space-progress', properties: { spaceId: entry.id, step, failure, timestamp: now().getTime() } });
  };

  /** Removes the space and everything the host kept for it, and says what did not go. */
  const removeEverything = async (spaceId: string, repository: string | null, source = records.read(spaceId).record?.source, trustedMigrationPath = records.read(spaceId).record?.trustedMigrationPath) => {
    creationAccessFailures.delete(spaceId);
    const outcome: SpaceRemoval = { removed: false, refsRemoved: null, failures: [] };
    // The subject goes first: a space on its way out calls no MCP connection, whatever else fails.
    if (HOST_PLACE_KINDS.has(placeKindOfSpace(spaceId))) {
      const answer = await mcpSubjects.remove(mcpSubjectOf(spaceId)).catch(() => ({ ok: false, code: 'protected_mcp_unavailable' }));
      if (!answer.ok && answer.code !== 'protected_mcp_unavailable') logger.warn?.(`[spaces] the protected MCP subject of space ${spaceId} stays: ${answer.code}`);
    }
    // The record goes with the space. It stays when the space could not be removed, so a space
    // whose place cannot be asked keeps its place in the list until the machine answers and the
    // delete goes through; the one exception is a place that is no longer configured, where
    // nothing from here can reach the space and the record is all there is to forget.
    let forgetRecord = true;
    try {
      await manager.removeSpace({ spaceId });
      outcome.removed = true;
    } catch (error) {
      outcome.failures.push(failureOf(error));
      forgetRecord = error instanceof SpaceError && error.code === 'place_not_found';
    }
    if (repository) {
      try {
        const input = { repository, spaceId, source, trustedMigrationPath };
        await codeIn.removeSpaceRefs(input);
        outcome.refsRemoved = true;
      } catch (error) {
        outcome.refsRemoved = false;
        if (error instanceof SpaceError && error.code === 'project_folder_missing') {
          logger.warn?.(`[spaces] the service refs of space ${spaceId} stay in its project folder, which is no longer at its path`);
        } else {
          outcome.failures.push(failureOf(error));
        }
      }
    }
    if (forgetRecord && !(source && outcome.refsRemoved === false)) records.remove(spaceId);
    return outcome;
  };

  const writeIdleStop = async (spaceId: string, setting: IdleStop) => {
    try {
      await serverInside.writeIdleStop(spaceId, setting);
    } catch (error) {
      logger.warn?.(`[spaces] space ${spaceId} keeps its idle stop setting: ${errorSummary(error)}`);
    }
  };

  const writePermissionDefault = async (spaceId: string, setting: PermissionDefault) => {
    try {
      await serverInside.writePermissionDefault(spaceId, setting);
    } catch (error) {
      logger.warn?.(`[spaces] space ${spaceId} keeps its default permission mode: ${errorSummary(error)}`);
    }
  };

  const deliverSettings = (spaceId: string) => {
    const delivery = settingsTurn.then(async () => {
      await writeIdleStop(spaceId, await readIdleStop());
      await writePermissionDefault(spaceId, await readPermissionDefault());
      await deliverUserTaskTitle(spaceId);
    });
    settingsTurn = delivery.catch(() => {});
    return delivery.catch((error) => {
      logger.warn?.(`[spaces] space ${spaceId} keeps its settings: ${error?.code ?? error?.message ?? error}`);
    });
  };

  const deliverUserTaskTitle = async (spaceId: string) => {
    const taskTitle = records.read(spaceId).record?.taskTitle;
    try {
      await serverInside.writeUserTaskTitle(spaceId, { title: taskTitle?.by === 'user' ? taskTitle.title : '' });
    } catch (error) {
      logger.warn?.(`[spaces] space ${spaceId} keeps its copy of the user task title: ${errorSummary(error)}`);
    }
  };

  const sendHistoryInBackground = ({ repository, spaceId, spacePath, base, source, trustedMigrationPath }: { repository: string; spaceId: string; spacePath: string; base: string; source?: TransferSource | undefined; trustedMigrationPath?: MigrationPath | undefined }) => {
    const input = { repository, spaceId, spacePath, base, source, trustedMigrationPath };
    codeIn.sendHistory(input)
      .then((result: { status: 'sent' | 'already_complete' | 'host_shallow' }) => { records.update(spaceId, { history: result.status }); })
      .catch(<Cause>(error: Cause) => {
        logger.warn?.(`[spaces] the history of space ${spaceId} did not arrive: ${spaceErrorProperty(spaceErrorProperty(error, 'details'), 'cause') ?? spaceErrorProperty(error, 'code') ?? spaceErrorProperty(error, 'message')}`);
        records.update(spaceId, { history: 'failed' });
      });
  };

  const prepare = async (entry: PendingSpace, { placeId, projectDirectory, sourceDirectory = projectDirectory, source, trustedMigrationPath, name, start, network, setupCommands, purpose, approvalModel, grants, activation }: Omit<z.infer<typeof createRequestSchema>, 'placeId'> & { placeId: string | undefined; sourceDirectory?: string | undefined; source?: TransferSource | undefined; trustedMigrationPath?: MigrationPath | undefined; activation: RootActivation | null }) => {
    let created = false;
    try {
      progress(entry, 'checking_place');
      const check = await requirePlace(placeId).check();
      if (!placeAnsweredAvailable(check)) throw new SpaceError(check.code, check.message);
      if (network.mode === 'allowlist' && check.hostIsolation !== true) {
        throw new SpaceError('place_cannot_restrict_network', 'This place cannot keep a space away from the machine it runs on, so an allowlist would not hold. Use a newer Docker engine, or choose the open network with that in mind.');
      }
      progress(entry, 'creating');
      const startConfig = buildStartConfig([...(await customDefinitionsOf(grants, projectDirectory)).keys()]);
      await prepareMcpSubject(entry.id, []);
      await manager.createSpace({ id: entry.id, placeId, projectDirectory, name, purpose, onStep: (step) => progress(entry, step), startConfig, activation });
      created = true;
    // With the place, the name and the time, so the space is still listed while its place cannot be asked.
      const record = { placeId, name: entry.name, created: entry.created, purpose, approvalModel, network, repository: sourceDirectory, source, trustedMigrationPath };
      records.write(entry.id, record);
      progress(entry, 'setting_network');
      await gatekeeper.setNetwork(entry.id, network);
      progress(entry, 'bringing_code');
      const input = { repository: sourceDirectory, spaceId: entry.id, mode: start, source, trustedMigrationPath };
      const arrived = await codeIn.bringCodeIn(input);
      records.update(entry.id, { spacePath: arrived.spacePath, base: arrived.base });
      entry.identityCopied = arrived.identityCopied;
      await deliverSettings(entry.id);
      if (grants.length > 0) {
        progress(entry, 'giving_access');
        const failures = [];
        for (const asked of grants) {
          try {
            await giveGrant(entry.id, asked);
          } catch (error) {
            failures.push({ provider: asked.provider, ...failureOf(error) });
          }
        }
        if (failures.length > 0) creationAccessFailures.set(entry.id, failures);
      }
      pending.delete(entry.id);
      progress(entry, 'ready');
      onSpacesChanged();
      if (setupCommands.length > 0) setup.start(entry.id, { projectPath: arrived.spacePath, commands: setupCommands });
      sendHistoryInBackground({ repository: sourceDirectory, spaceId: entry.id, spacePath: arrived.spacePath, base: arrived.base, source, trustedMigrationPath });
    } catch (error) {
      const failure = failureOf(error);
      if (created) {
        const cleanup = await removeEverything(entry.id, sourceDirectory, source, trustedMigrationPath);
        if (cleanup.failures.length > 0) failure.cleanup = cleanup.failures;
      }
      logger.warn?.(`[spaces] creating space ${entry.id} failed at ${entry.step}: ${failure.code}`);
      progress(entry, 'failed', failure);
    }
  };

  /**
   * Starts making a space and answers at once with the entry the list will carry. The four
   * choices of the create dialog come in: the project, the name, the starting point and the
   * network. The place is checked inside, as decision 19 asks: nothing probes a runtime before
   * the user acts.
   */
  const createSpace = async <Request>(request: Request, { sourceDirectory, source: rawSource, onAllocated, waitUntilReady = false }: InternalCreation = {}) => {
    if (closing) throw new SpaceError('isolated_spaces_off', 'Isolated spaces are being turned off.');
    const parsed = createRequestSchema.safeParse(request ?? {});
    if (!parsed.success) {
      const [code, message] = CREATE_REFUSALS[parsed.error.issues[0]?.path?.[0] ?? 'undefined'] ?? CREATE_REFUSALS.network;
      throw new SpaceError(code, message);
    }
    const { name, start, network, setupCommands, purpose, grants } = parsed.data;
    requireProfileNetwork(purpose, network);
    const approvalModel = requireApprovalModel(purpose, parsed.data.approvalModel);
    const placeId = parsed.data.placeId ?? places.list()[0]?.id;
    requirePlace(placeId);
    const projectDirectory = await requireRegisteredProject(parsed.data.projectDirectory);
    const source = rawSource === undefined ? undefined : transferSourceSchema.parse(rawSource);
    if (source && (source.kind === 'project' ? source.directory : source.projectDirectory) !== projectDirectory) {
      throw new SpaceError('agent_project_mismatch', 'The code source must belong to the registered project.');
    }
    const captured = source && 'captureTransferSource' in codeIn && codeIn.captureTransferSource
      ? await codeIn.captureTransferSource({ source, repository: sourceDirectory ?? projectDirectory }) : {};
    const trustedMigrationPath = captured.trustedMigrationPath === undefined ? undefined : botMigrationPathSchema.parse(captured.trustedMigrationPath);
    const id = requireCreationId(placeId, purpose, parsed.data);
    const entry: PendingSpace = {
      id,
      name,
      placeId,
      projectDirectory,
      sourceDirectory: sourceDirectory ?? projectDirectory,
      source,
      trustedMigrationPath,
      directory: spaceProjectPath(id, sourceDirectory ?? projectDirectory),
      created: now().toISOString(),
      state: 'preparing',
      step: 'checking_place',
      failure: null,
      network,
      purpose,
      approvalModel,
      setupTotal: setupCommands.length,
    };
    // Internal worker owners persist the allocation before any container can run.
    // HTTP callers supply only `request` and cannot override the code source.
    if (onAllocated) await onAllocated({ id, directory: entry.directory });
    pending.set(entry.id, entry);
    const preparing = prepare(entry, { placeId, projectDirectory, sourceDirectory, source, trustedMigrationPath, name, start, network, setupCommands, purpose, approvalModel, grants, activation: parsed.data.rootActivation ?? null });
    if (waitUntilReady) {
      await preparing;
      if (entry.failure) throw new SpaceError(entry.failure.code, String(entry.failure.message));
      return requireListed(id);
    }
    void preparing;
    return describePending(entry);
  };

  /**
   * The id of a new space. A root place takes the one its passkey confirmation was asked for, and
   * refuses a creation without one; every other place makes its own and takes none from outside.
   */
  const requireCreationId = (placeId: string | undefined, purpose: SpacePurpose, { spaceId, rootActivation }: z.infer<typeof createRequestSchema>) => {
    if (placeKindOf(placeId) !== ROOT_PLACE_KIND) {
      if (spaceId !== undefined || rootActivation !== undefined) throw new SpaceError('root_activation_unexpected', 'Only a root space is created with a passkey confirmation.');
      return createSpaceId();
    }
    if (purpose !== 'general') throw new SpaceError('root_place_not_allowed', 'An approval worker never runs as root.');
    if (spaceId === undefined || rootActivation === undefined) throw new SpaceError('root_activation_required', 'A root space is created only with a passkey confirmation made for it.');
    if (pending.has(spaceId) || records.read(spaceId).record) throw new SpaceError('space_name_taken', 'This confirmation was made for a space that exists. Ask for a new one.');
    return spaceId;
  };

  /**
   * What the root component needs to ask for a passkey confirmation: for a creation, the space it
   * would make, under a new id the creation must then carry; for a start, the space's own id, whose
   * spec the root component reads from its own record. Answers the challenge, the approved passkeys
   * and, for a creation, the id.
   */
  const rootActivationOptions = async (input: RootActivationRequest) => {
    const { op } = input;
    if (op === 'create') {
      const parsed = createRequestSchema.omit({ spaceId: true, rootActivation: true }).safeParse(input.request ?? {});
      if (!parsed.success) {
        const [code, message] = CREATE_REFUSALS[parsed.error.issues[0]?.path?.[0] ?? 'undefined'] ?? CREATE_REFUSALS.network;
        throw new SpaceError(code, message);
      }
      const { placeId, name, purpose } = parsed.data;
      requirePlace(placeId);
      if (placeKindOf(placeId) !== ROOT_PLACE_KIND) throw new SpaceError('root_activation_unexpected', 'Only a root space is created with a passkey confirmation.');
      if (purpose !== 'general') throw new SpaceError('root_place_not_allowed', 'An approval worker never runs as root.');
      const projectDirectory = await requireRegisteredProject(parsed.data.projectDirectory);
      const id = createSpaceId();
      const spec = activationSpecOf({ id, projectDirectory, name, purpose });
      return { spaceId: id, ...(await requireRootPlace().rootActivationOptions({ op, spec })) };
    }
    if (op !== 'start') throw new SpaceError('root_activation_invalid', 'A root space is confirmed for a creation or a start.');
    const { spaceId } = input;
    requireNotPending(spaceId);
    const placeId = records.read(spaceId).record?.placeId;
    if (placeKindOf(placeId) !== ROOT_PLACE_KIND) throw new SpaceError('root_activation_unexpected', 'Only a root space is started with a passkey confirmation.');
    return requireRootPlace().rootActivationOptions({ op, id: spaceId });
  };

  const requireRootPlace = () => {
    for (const place of places.list()) {
      if ('rootStatus' in place && place.kind === ROOT_PLACE_KIND) return place;
    }
    throw new SpaceError('place_not_found', 'This computer has no place for root spaces.');
  };

  /**
   * Whether root spaces may run, and the passkeys approved for them, as the root component says;
   * `hostd_unavailable` when it cannot be asked, so the screens can say what to install.
   */
  const readRootPasskeys = async () => {
    try {
      return await requireRootPlace().rootStatus();
    } catch (error) {
      const code = spaceErrorProperty(error, 'code');
      if (typeof code === 'string' && HOSTD_UNAVAILABLE.has(code)) return { available: false, reason: 'hostd_unavailable', passkeys: [] };
      throw error;
    }
  };

  /** The challenge of a root passkey approval, for the code the root command printed. */
  const rootApprovalChallenge = async (body: unknown) => {
    const parsed = rootApprovalCodeSchema.safeParse(body ?? {});
    if (!parsed.success) throw new SpaceError('approval_code_invalid', 'The approval code is two groups of four letters and digits, as the root command printed it.');
    return requireRootPlace().rootApprovalChallenge(parsed.data.code);
  };

  /**
   * The proof of a root passkey approval, with one of the owner's sign-in passkeys:
   * `credentialOf(id)` answers that passkey's id, public key and RP ID at this address, or null.
   * The root command shows the answer's fingerprint and approves nothing until the person confirms it there.
   */
  const completeRootApproval = async (body: unknown, credentialOf: (id: string) => ApprovalCredential | null) => {
    const parsed = rootApprovalSchema.safeParse(body ?? {});
    if (!parsed.success) {
      const [code, message] = parsed.error.issues[0]?.path?.[0] === 'code'
        ? ['approval_code_invalid', 'The approval code is two groups of four letters and digits, as the root command printed it.']
        : CREATE_REFUSALS.rootActivation;
      throw new SpaceError(code, message);
    }
    const credential = credentialOf(parsed.data.response.id);
    if (!credential) throw new SpaceError('ui_passkey_missing', 'That passkey does not sign in to OpenChamber at this address.');
    const { code, response, label } = parsed.data;
    const { userHandle, ...signed } = response.response;
    const { authenticatorAttachment, ...assertion } = response;
    const signedResponse = userHandle === undefined ? signed : { ...signed, userHandle };
    const canonical = { ...assertion, response: signedResponse };
    const proofResponse = authenticatorAttachment === undefined ? canonical : { ...canonical, authenticatorAttachment };
    const proof = { code, credential: { id: credential.id, publicKey: credential.publicKey, rpID: credential.rpID }, response: proofResponse, ...(label === undefined ? {} : { label }) };
    return requireRootPlace().rootApprovalComplete(proof);
  };

  /** A grant as the list and the grant route show it: everything the record holds, which holds no value. */
  const describeGrant = (grant: Grant) => (throughWindow(grant) ? { ...grant, url: spaceWindowUrl(grant.id) } : { ...grant });

  /** Whether a grant has an entry in OpenCode's configuration inside: a key, a login, a custom provider or an MCP connection. */
  const configuresProvider = (grant: Grant) => grant.kind === 'model' || grant.kind === 'login' || grant.kind === 'custom' || grant.kind === 'mcp';
  /** Whether the gatekeeper holds a grant: everything but an MCP connection, which the protected MCP service carries. */
  const throughWindow = (grant: Grant) => grant.kind !== 'mcp';

  const customWindowOf = (definition: CustomDefinition | null) => {
    if (!definition) return null;
    const upstream = definition.baseURL === null ? null : windowUpstreamOf(definition.baseURL);
    const header = headerOfProvider(definition);
    if (upstream === null || header === null) return null;
    const window: { upstream: string; header: string | null; secret: string | null; headers?: CustomDefinition['headers'] } = definition.key === null ? { upstream, header: null, secret: null } : { upstream, header, secret: definition.key };
    if (Object.keys(definition.headers).length > 0) window.headers = definition.headers;
    return window;
  };

  const customDefinitionsOf = async (grants: (Grant | z.infer<typeof creationGrantsSchema>[number])[], repository: string | null) => {
    const definitions = new Map<string, Omit<CustomDefinition, 'key'>>();
    for (const grant of grants) {
      if (grant.kind !== 'custom') continue;
      const definition = await hostProviders.read(grant.provider, repository).catch(() => null);
      if (!definition) {
        logger.warn?.(`[spaces] the custom provider ${grant.provider} is not in the host's configuration now; the space is not told about it`);
        continue;
      }
      const { key: _key, ...rest } = definition;
      definitions.set(grant.provider, rest);
    }
    return definitions;
  };

  const writeProviderConfig = async (spaceId: string, grants: Grant[], repository: string | null) => {
    const catalog = await modelGrants.catalogDefinitionsOf(grants, repository);
    await spaceOpenCode.writeProviderConfig(spaceId, grants, await customDefinitionsOf(grants, repository), catalog);
  };

  const deliverGrant = async (spaceId: string, grant: Grant, login: StoredLogin | null = null, repository: string | null = null) => {
    if (grant.kind === 'mcp') {
      const answer = await syncMcpSubject(spaceId, records.read(spaceId).record?.grants ?? []);
      if (!answer.ok) logger.warn?.(`[spaces] the MCP grant ${grant.id} of space ${spaceId} could not be said again: ${answer.code}`);
      return answer.ok;
    }
    let secret: string | null = null;
    let upstream = grant.kind === 'login' || grant.kind === 'custom' ? null : grant.upstream;
    let header = grant.kind === 'model' ? grant.header : null;
    let headers: CustomDefinition['headers'] | undefined;
    if (grant.kind === 'model') {
      if (grant.source.kind === 'typed') return false;
      const modelSecret = await modelGrants.secretOf(grant.source).catch(() => null);
      if (!isSecretString(modelSecret) || modelSecret === '') return false;
      secret = modelSecret;
      headers = (await modelGrants.catalogHeadersFor(grant, repository)) ?? undefined;
    }
    if (grant.kind === 'login') {
      const window = login ? loginWindowOf(grant.provider, login) : null;
      if (!window) return false;
      ({ upstream, header, secret } = window);
    }
    if (grant.kind === 'custom') {
      const window = customWindowOf(await hostProviders.read(grant.provider, repository).catch(() => null));
      if (!window) return false;
      ({ upstream, header, secret, headers } = window);
    }
    try {
      const said: GatekeeperGrant = { id: grant.id, upstream, header, secret };
      if (headers) said.headers = headers;
      const { record } = records.read(spaceId);
      if (!record) return false;
      requireProfileGrants(record);
      if (record.purpose === approvalPolicy.purpose) {
        said.model = record.approvalModel;
        requireApprovalModelWindow(said);
      }
      await gatekeeper.addGrant(spaceId, said);
      return true;
    } catch (error) {
      logger.warn?.(`[spaces] the grant ${grant.id} of space ${spaceId} could not be said again: ${errorSummary(error)}`);
      return false;
    }
  };

  const rewriteProviderConfig = async (spaceId: string, grants: Grant[], repository: string | null) => {
    if (!grants.some((grant) => configuresProvider(grant))) return;
    try {
      await writeProviderConfig(spaceId, grants, repository);
    } catch (error) {
      logger.warn?.(`[spaces] the provider configuration of space ${spaceId} was not written again: ${errorSummary(error)}`);
    }
  };

  const usableHostLogin = async (grant: LoginGrant) => {
    const login = await readHostLogin(grant.provider).catch(() => null);
    if (!login || login.methodID !== grant.method || loginEnded(grant.provider, login, now().getTime())) return null;
    return login;
  };

  const restoreGrants = async (spaceId: string, grants: Grant[], repository: string | null) => {
    const restored: string[] = [];
    const needsAccess: string[] = [];
    for (const grant of grants) {
      const login = grant.kind === 'login' ? await usableHostLogin(grant) : null;
      (await deliverGrant(spaceId, grant, login, repository) ? restored : needsAccess).push(grant.id);
    }
    return { restored, needsAccess };
  };

  const repairLoginRowInBackground = (spaceId: string) => {
    void (async () => {
      await serverInside.waitUntilReady(spaceId);
      for (let attempt = 0; busy.has(spaceId); attempt += 1) {
        if (attempt >= REPAIR_BUSY_ATTEMPTS) {
          logger.info?.(`[spaces] the login row of space ${spaceId} was left to the action under way`);
          return;
        }
        await pause(REPAIR_BUSY_PAUSE_MS);
      }
      const writing = (async () => {
        const { record } = records.read(spaceId);
        if (!record) return;
        const written = new Set<string>();
        for (const grant of record.grants) {
          if (grant.kind !== 'login') continue;
          const login = await usableHostLogin(grant);
          if (!login) continue;
          await spaceOpenCode.writeLogin(spaceId, grant.provider, login);
          written.add(grant.provider);
        }
        for (const provider of LOGIN_PROVIDERS) if (!written.has(transferValue(provider))) await spaceOpenCode.removeLogin(spaceId, provider);
      })();
      rowRepairs.set(spaceId, writing);
      try {
        await writing;
      } finally {
        if (rowRepairs.get(spaceId) === writing) rowRepairs.delete(spaceId);
      }
    })().catch((error) => {
      logger.warn?.(`[spaces] the login row of space ${spaceId} was not written again: ${error?.code ?? error?.message ?? error}`);
    });
  };
  const readHostLogins = async () => {
    const logins = [];
    for (const provider of LOGIN_PROVIDERS) {
      const login = await readHostLogin(transferValue(provider));
      if (!login) continue;
      const end = loginEndOf(provider, login);
      const state = !loginWindowOf(provider, login) ? 'unsupported' : loginEnded(provider, login, now().getTime()) ? 'expired' : 'usable';
      logins.push({ provider, method: login.methodID, expires: end === null ? null : new Date(end).toISOString(), state });
    }
    return { logins };
  };

  const readHostCustomProviders = async (directory: string | null) => {
    const providers = (await hostProviders.list(directory)).filter((provider) => !isProviderKnownByName(provider.id) && !LOGIN_PROVIDERS.includes(provider.id));
    return { providers };
  };

  const afterRowRepair = (spaceId: string) => (rowRepairs.get(spaceId) ?? Promise.resolve()).catch(() => {});

  const sayLogin = async (spaceId: string, grant: LoginGrant, login: StoredLogin) => {
    if (busy.has(spaceId)) return null;
    return deliverGrant(spaceId, grant, login);
  };

  const restoreLostGrants = async () => {
    let spaces;
    try {
      ({ spaces } = await listAll());
    } catch (error) {
      logger.warn?.(`[spaces] could not list the spaces to say their grants again: ${errorSummary(error)}`);
      return;
    }
    for (const space of spaces) {
      if (space.state !== 'running' || busy.has(space.id)) continue;
      const record = records.read(space.id).record;
      const grants = (record?.grants ?? []).filter((grant) => throughWindow(grant) && (grant.kind !== 'model' || grant.source.kind !== 'typed'));
      if (grants.length === 0) continue;
      let held;
      try {
        held = new Set((await gatekeeper.readPolicy(space.id)).grants);
      } catch (error) {
        logger.warn?.(`[spaces] the gatekeeper of space ${space.id} did not say what it holds: ${errorSummary(error)}`);
        continue;
      }
      const lost = grants.filter((grant) => !held.has(grant.id));
      if (lost.length === 0) continue;
      try {
        const { restored } = await exclusive(space.id, () => restoreGrants(space.id, lost, projectDirectoryOf(record)));
        if (restored.length > 0) logger.info?.(`[spaces] said the grants ${restored.join(', ')} of space ${space.id} again`);
      } catch (error) {
        logger.warn?.(`[spaces] the grants of space ${space.id} were not said again: ${errorSummary(error)}`);
      }
    }
    onSpacesChanged();
  };

  const readAccess = async (space: ListedSpace, allGrants: Grant[]) => {
    const grants = allGrants.filter(throughWindow);
    if (space.state !== 'running' || grants.length === 0 || busy.has(space.id)) return { access: null, needsAccess: [] };
    try {
      const held = new Set((await gatekeeper.readPolicy(space.id)).grants);
      const needsAccess = grants.filter((grant) => !held.has(grant.id)).map((grant) => grant.id);
      return { access: needsAccess.length === 0 ? 'granted' : 'needs_access', needsAccess };
    } catch (error) {
      logger.warn?.(`[spaces] the gatekeeper of space ${space.id} did not say what it holds: ${errorSummary(error)}`);
      return { access: 'unknown', needsAccess: [] };
    }
  };

  const readDamage = async (space: ListedSpace) => {
    if (!space.damaged) return null;
    const missing: readonly string[] = space.missing;
    if (!missing.includes(spaceResourceName(space.id, ROLE_GATEKEEPER))) return 'repairable';
    try {
      const violations = await manager.verify(space.id);
      return violations.some((violation) => violation.check === 'gatekeeper_missing') ? 'gatekeeper_gone' : 'repairable';
    } catch (error) {
      if (error instanceof SpaceError && error.code === 'gatekeeper_missing') return 'gatekeeper_gone';
      logger.warn?.(`[spaces] space ${space.id} could not be verified: ${errorSummary(error)}`);
      return 'repairable';
    }
  };

  const describePending = (entry: PendingSpace) => ({
    id: entry.id,
    name: entry.name,
    taskTitle: records.read(entry.id).record?.taskTitle ?? null,
    placeId: entry.placeId,
    kind: placeKindOf(entry.placeId),
    machine: places.get(entry.placeId)?.machine ?? null,
    projectDirectory: entry.projectDirectory,
    directory: entry.directory,
    projectFolder: { path: entry.projectDirectory, found: null },
    created: entry.created,
    state: entry.state,
    stoppedIdle: false,
    step: entry.step,
    failure: entry.failure,
    network: entry.network,
    purpose: entry.purpose,
    approvalModel: entry.approvalModel,
    history: 'pending',
    setup: entry.setupTotal > 0 ? { state: 'queued', total: entry.setupTotal } : null,
    grants: [],
    accessFailures: [],
    access: null,
    needsAccess: [],
    damaged: false,
    damage: null,
    missing: [],
    orphans: [],
  });

  const listSpaces = async ({ access = false } = {}) => {
    const [{ spaces, unavailable }, projects] = await Promise.all([listAll(), registeredProjects()]);
    const placeFailureOf = (placeId: string) => failureOf(unavailable.find((entry) => entry.placeId === placeId)?.failure);
    const listed = await Promise.all(spaces.map(async (space) => {
      const projectDirectory = projects.get(space.project) ?? null;
      const { record } = records.read(space.id);
      const grants = record?.grants ?? [];
      const projectPath = projectDirectoryOf(record) ?? projectDirectory;
      const codeNeverArrived = space.state !== 'unreachable' && record !== null && record.spacePath === null;
      return {
        id: space.id,
        name: space.name,
        taskTitle: record?.taskTitle ?? null,
        placeId: space.placeId,
        kind: placeKindOf(space.placeId),
        machine: places.get(space.placeId)?.machine ?? null,
        projectDirectory,
        directory: projectDirectory === null ? null : (record?.spacePath ?? spaceProjectPath(space.id, projectDirectory)),
        projectFolder: { path: projectPath, found: projectPath === null ? null : await folderExists(projectPath) },
        created: space.created,
        state: codeNeverArrived ? 'failed' : space.state,
        stoppedIdle: space.stoppedIdle === true,
        step: codeNeverArrived ? 'failed' : null,
        failure: codeNeverArrived
          ? { code: 'space_code_never_arrived', message: 'OpenChamber closed before the code arrived. Delete the space and create it again.', details: null }
          : space.state === 'unreachable' ? placeFailureOf(space.placeId) : null,
        network: record?.network ?? null,
        purpose: space.purpose ?? record?.purpose ?? 'general',
        approvalModel: record?.approvalModel ?? null,
        history: record?.history ?? 'unknown',
        setup: setup.describe(space.id, record),
        grants: grants.map(describeGrant),
        accessFailures: creationAccessFailures.get(space.id) ?? [],
        ...(access ? await readAccess(space, grants) : { access: null, needsAccess: [] }),
        damaged: space.damaged,
        damage: await readDamage(space),
        missing: space.missing,
        orphans: space.orphans,
      };
    }));
    for (const space of spaces) {
      if (space.state === 'exited' && space.gatekeeperRunning === true && !pending.has(space.id)) stopStrayGatekeeper(space.id);
    }
    const waiting = new Map(Array.from(pending.values(), (entry) => [entry.id, describePending(entry)]));
    const merged = listed.map((space) => waiting.get(space.id) ?? space);
    const known = new Set(listed.map((space) => space.id));
    return [...merged, ...Array.from(waiting.values()).filter((entry) => !known.has(entry.id))];
  };

  const stopStrayGatekeeper = (spaceId: string) => {
    if (busy.has(spaceId) || strayStops.has(spaceId)) return;
    const stopping = manager.stopSpace({ spaceId })
      .catch((error) => {
        logger.warn?.(`[spaces] the gatekeeper beside stopped space ${spaceId} still runs: ${error?.code ?? error?.message ?? error}`);
      })
      .finally(() => { strayStops.delete(spaceId); });
    strayStops.set(spaceId, stopping);
  };

  const requireListed = async (spaceId: string) => {
    const space = (await listSpaces()).find((entry) => entry.id === spaceId);
    if (!space) throw new SpaceError('space_not_found', `There is no space ${spaceId}`);
    return space;
  };

  const setTaskTitle = async <Title>(spaceId: string, title: Title) => {
    const space = await requireListed(spaceId);
    const result = records.setTaskTitle(spaceId, { title, by: 'user' });
    announce(spaceId, { type: 'openchamber:space-task-title.updated', properties: { spaceId, taskTitle: result.taskTitle } });
    if (space.state === 'running') {
      const delivery = settingsTurn.then(() => deliverUserTaskTitle(spaceId));
      settingsTurn = delivery.catch(() => {});
      await delivery;
    }
    return result;
  };

  const startUnlocked = async (spaceId: string, activation: RootActivation | null = null) => {
    if (closing) throw new SpaceError('isolated_spaces_off', 'Isolated spaces are being turned off.');
    requireNotPending(spaceId);
    requireStartActivation(spaceId, activation);
    await strayStops.get(spaceId);
    const { record } = records.read(spaceId);
    if (record) requireProfileGrants(record);
    await prepareMcpSubject(spaceId, record?.grants ?? []);
    await manager.startSpace({ spaceId, activation });
    let networkRestored = false;
    let grants: RestoredGrants = { restored: [], needsAccess: [] };
    if (record) {
      await gatekeeper.setNetwork(spaceId, record.network);
      networkRestored = true;
      grants = await restoreGrants(spaceId, record.grants, projectDirectoryOf(record));
      await rewriteProviderConfig(spaceId, record.grants, projectDirectoryOf(record));
      if (record.grants.some((grant) => grant.kind === 'model' || grant.kind === 'login')) repairLoginRowInBackground(spaceId);
      if ((record.history === 'pending' || record.history === 'failed') && record.repository && record.spacePath && record.base) {
        sendHistoryInBackground({ repository: record.repository, spaceId, spacePath: record.spacePath, base: record.base, source: record.source, trustedMigrationPath: record.trustedMigrationPath });
      }
    }
    await deliverSettings(spaceId);
    onSpacesChanged();
    return { ...(await requireListed(spaceId)), networkRestored, grantsRestored: grants.restored, needsAccess: grants.needsAccess };
  };
  const startSpace = (spaceId: string, { rootActivation = null }: { rootActivation?: unknown } = {}) => exclusive(spaceId, () => startUnlocked(spaceId, parseActivation(rootActivation)));

  /** A confirmation from a request, bounded; null when the request carries none. */
  const parseActivation = (value: unknown) => {
    if (value === null || value === undefined) return null;
    const parsed = rootActivationSchema.safeParse(value);
    if (!parsed.success) throw new SpaceError(...CREATE_REFUSALS.rootActivation);
    return parsed.data;
  };

  /** A root space starts only with a confirmation, and no other space takes one. */
  const requireStartActivation = (spaceId: string, activation: RootActivation | null) => {
    const root = placeKindOfSpace(spaceId) === ROOT_PLACE_KIND;
    if (root && activation === null) throw new SpaceError('root_activation_required', 'A root space is started only with a passkey confirmation made for this start.');
    if (!root && activation !== null) throw new SpaceError('root_activation_unexpected', 'Only a root space is started with a passkey confirmation.');
  };

  const restartSpace = (spaceId: string, { rootActivation = null }: { rootActivation?: unknown } = {}) => exclusive(spaceId, async () => {
    if (closing) throw new SpaceError('isolated_spaces_off', 'Isolated spaces are being turned off.');
    requireNotPending(spaceId);
    // Before the stop: a root space without its confirmation must not end up stopped by this.
    const activation = parseActivation(rootActivation);
    requireStartActivation(spaceId, activation);
    const space = await requireListed(spaceId);
    if (space.state !== 'running') throw new SpaceError('space_not_running', 'This space is stopped. Start it instead.');
    try {
      await serverInside.writeToken(spaceId, createSpaceToken());
    } catch (error) {
      logger.warn?.(`[spaces] the server inside space ${spaceId} keeps its token: ${errorSummary(error)}`);
    }
    await manager.stopSpace({ spaceId });
    return startUnlocked(spaceId, activation);
  });

  const restartOpenCode = (spaceId: string) => exclusive(spaceId, async () => {
    requireNotPending(spaceId);
    const space = await requireListed(spaceId);
    if (space.state !== 'running') throw new SpaceError('space_not_running', 'OpenCode runs inside a running space. Start the space.');
    await restartOpenCodeInside(spaceId);
    await deliverUserTaskTitle(spaceId);
    onSpacesChanged();
    return requireListed(spaceId);
  });

  const giveGrant = async (spaceId: string, asked: z.infer<typeof grantRequestSchema>) => {
    const current = records.read(spaceId);
    if (current.status !== 'ok') throw new SpaceError('space_record_unreadable', 'The host\'s record of this space cannot be read, so a grant could not be remembered. Remove the space and create it again.');
    requireProfileGrants(current.record);
    const space = await requireListed(spaceId);
    if (space.purpose !== current.record.purpose) throw new SpaceError('space_purpose_immutable', 'The runtime and host record purposes differ. Remove this space and create it again.');
    if (current.record.purpose === approvalPolicy.purpose && !['model', 'login'].includes(asked.kind)) {
      throw new SpaceError('space_approval_grant_denied', 'Approval workers accept only supported model keys or host logins. Domain and custom grants are unavailable.');
    }
    if (asked.kind === 'mcp') return giveMcpGrant(spaceId, current.record, asked);
    let grant: Grant;
    let window: Omit<GatekeeperGrant, 'id'> | null;
    let login: StoredLogin | null = null;
    if (asked.kind === 'custom') {
      const definition = await hostProviders.read(asked.provider, projectDirectoryOf(current.record));
      if (!definition) throw new SpaceError('provider_not_found', `${asked.provider} is not a provider of your own in Settings. Add it there, then grant.`);
      if (headerOfProvider(definition) === null) throw new SpaceError('provider_not_supported', `${definition.name} cannot be given through the network filter yet: its SDK, or a model's own SDK, reads a key in a way the network filter does not know.`);
      window = customWindowOf(definition);
      if (!window) throw new SpaceError('provider_not_supported', `${definition.name} has no http(s) address in Settings.`);
      grant = { kind: 'custom', id: asked.provider, provider: asked.provider };
    } else if (asked.kind === 'model') {
      ({ grant, window } = await modelGrants.modelGrantOf(asked, projectDirectoryOf(current.record)));
    } else if (asked.kind === 'login') {
      login = await readHostLogin(asked.provider);
      if (!login) throw new SpaceError('login_not_found', `OpenChamber is not signed in to ${asked.provider} on this computer. Sign in first, or give a key instead.`);
      window = loginWindowOf(asked.provider, login);
      if (!window) throw new SpaceError('login_not_supported', `The ${asked.provider} login on this computer was made in a way the network filter does not know (${login.methodID}).`);
      if (loginEnded(asked.provider, login, now().getTime())) throw new SpaceError('login_expired', `The ${asked.provider} login on this computer has run out and could not be renewed. Sign in to ${asked.provider} again, then grant.`);
      grant = { kind: 'login', id: asked.provider, provider: asked.provider, method: login.methodID };
    } else {
      grant = { kind: 'domain', id: `open-${crypto.randomBytes(6).toString('hex')}`, upstream: asked.upstream };
      window = { upstream: grant.upstream, header: null, secret: null };
    }
    // A key that replaces a login takes the login's row with it first, or OpenCode inside would
    // keep the login's headers and model list for requests the window now sends with the key; a
    // removal that fails answers the grant before anything changed.
    if (current.record.purpose === approvalPolicy.purpose) {
      window.model = current.record.approvalModel;
      requireApprovalModelWindow({ id: grant.id, ...window });
    }
    const replaced = current.record.grants.find((entry) => entry.id === grant.id);
    if (grant.kind !== 'login' && replaced?.kind === 'login') await spaceOpenCode.removeLogin(spaceId, grantProvider(grant));
    await gatekeeper.addGrant(spaceId, { id: grant.id, ...window });
    const grants = [...current.record.grants.filter((entry) => entry.id !== grant.id), grant];
    if (records.update(spaceId, { grants }).status !== 'ok') {
      throw new SpaceError('space_record_unreadable', 'The grant reached the network filter and could not be remembered, so it is gone at the next start. Remove the space and create it again.');
    }
    if (configuresProvider(grant)) await writeProviderConfig(spaceId, grants, projectDirectoryOf(current.record));
    if (grant.kind === 'login') await spaceOpenCode.writeLogin(spaceId, grant.provider, login);
    return grant;
  };

  /**
   * Gives a running space on this computer's users a protected MCP connection: the protected
   * service lets the space's own subject call it first, then the record keeps it, then OpenCode
   * inside learns its name. A second grant under the same name replaces the connection, as a key
   * replaces a key. A Docker space has no way to the service, so it is refused there.
   */
  const giveMcpGrant = async (spaceId: string, record: SpaceRecord, asked: Extract<GrantRequest, { kind: 'mcp' }>) => {
    if (!HOST_PLACE_KINDS.has(placeKindOf(record.placeId))) {
      throw new SpaceError('mcp_grant_unsupported_place', 'MCP servers are given only to spaces on this computer\'s isolated users. A Docker space has no way to the protected MCP service.');
    }
    const grant: Extract<Grant, { kind: 'mcp' }> = { kind: 'mcp', id: `mcp-${asked.name}`, connection: asked.connection, name: asked.name };
    const grants = [...record.grants.filter((entry) => entry.id !== grant.id), grant];
    const answer = await syncMcpSubject(spaceId, grants);
    if (!answer.ok) {
      throw answer.code === 'unknown_connection'
        ? new SpaceError('mcp_connection_not_found', 'That MCP server is not among the protected MCP servers of this computer.')
        : new SpaceError('protected_mcp_unavailable', `The protected MCP service did not take the grant (${answer.code}). Check that it runs, in Settings → MCP.`);
    }
    if (records.update(spaceId, { grants }).status !== 'ok') {
      // The service already lets the space call it: take that back, the record is what the next start says.
      await syncMcpSubject(spaceId, record.grants);
      throw new SpaceError('space_record_unreadable', 'The MCP grant could not be remembered. Remove the space and create it again.');
    }
    await writeProviderConfig(spaceId, grants, projectDirectoryOf(record));
    return grant;
  };

  const grantAccess = async <Request>(spaceId: string, request: Request) => {
    await afterRowRepair(spaceId);
    return grantUnlocked(spaceId, request);
  };
  const grantUnlocked = <Request>(spaceId: string, request: Request) => exclusive(spaceId, async () => {
    requireNotPending(spaceId);
    const parsed = grantRequestSchema.safeParse(request ?? {});
    if (!parsed.success) throw new SpaceError('invalid_grant_request', 'A grant is a model key for a provider, typed or named by a host environment variable, the host\'s own login for a provider, or an opened domain.');
    const space = await requireListed(spaceId);
    if (space.state !== 'running') throw new SpaceError('space_not_running', 'A grant goes to the gatekeeper of a running space. Start the space, then grant.');
    const grant = await giveGrant(spaceId, parsed.data);
    const failures = (creationAccessFailures.get(spaceId) ?? []).filter((failure) => failure.provider !== grantProvider(grant));
    if (failures.length > 0) creationAccessFailures.set(spaceId, failures);
    else creationAccessFailures.delete(spaceId);
    return { grant: describeGrant(grant) };
  });

  const openDomain = <Request>(spaceId: string, request: Request) => exclusive(spaceId, async () => {
    requireNotPending(spaceId);
    const parsed = openDomainRequestSchema.safeParse(request ?? {});
    if (!parsed.success) throw new SpaceError('invalid_domain', 'A domain is a name such as registry.npmjs.org: letters, digits and hyphens, with a dot.');
    const { domain } = parsed.data;
    const space = await requireListed(spaceId);
    if (space.state !== 'running') throw new SpaceError('space_not_running', 'A domain is opened by the gatekeeper of a running space. Start the space, then open it.');
    const current = records.read(spaceId);
    if (current.status !== 'ok') throw new SpaceError('space_record_unreadable', 'The host\'s record of this space cannot be read, so an opened domain could not be remembered. Remove the space and create it again.');
    if (space.purpose === approvalPolicy.purpose || current.record.purpose === approvalPolicy.purpose) {
      throw new SpaceError('space_approval_network_locked', 'An approval worker permanently keeps an empty allowlist. Create a separate ordinary space for network access.');
    }
    const { network } = current.record;
    if (network.mode === 'open') throw new SpaceError('network_is_open', 'The network of this space is open, so there is no list to add a domain to.');
    if (network.domains.includes(domain)) return { network };
    const next = networkSchema.safeParse({ mode: network.mode, domains: [...network.domains, domain] });
    if (!next.success) throw new SpaceError('too_many_domains', 'This space already has as many opened domains as a list holds.');
    await gatekeeper.setNetwork(spaceId, next.data);
    if (records.update(spaceId, { network: next.data }).status !== 'ok') {
      throw new SpaceError('space_record_unreadable', 'The domain is open now and could not be remembered, so it closes at the next start. Remove the space and create it again.');
    }
    return { network: next.data };
  });

  const runSetup = <Request>(spaceId: string, request: Request) => exclusive(spaceId, async () => {
    requireNotPending(spaceId);
    const parsed = setupRequestSchema.safeParse(request ?? {});
    if (!parsed.success) throw new SpaceError(...CREATE_REFUSALS.setupCommands);
    const space = await requireListed(spaceId);
    if (space.state !== 'running') throw new SpaceError('space_not_running', 'The setup commands run inside a running space. Start the space.');
    const { record } = records.read(spaceId);
    if (!record?.spacePath) throw new SpaceError('space_record_unreadable', 'The host\'s record of this space cannot be read, so it does not know where the project is inside. Remove the space and create it again.');
    setup.start(spaceId, { projectPath: record.spacePath, commands: parsed.data.commands });
    return requireListed(spaceId);
  });

  const readSetup = async (spaceId: string) => {
    const space = await requireListed(spaceId);
    return { setup: space.setup, output: setup.outputOf(records.read(spaceId).record) };
  };

  const stopSpace = (spaceId: string) => exclusive(spaceId, async () => {
    requireNotPending(spaceId);
    await manager.stopSpace({ spaceId });
    onSpacesChanged();
    return requireListed(spaceId);
  });

  const saveChatsOf = async (space: Awaited<ReturnType<typeof requireListed>>, allowUnsaved: boolean) => {
    if (!archiveChats) return null;
    let running = space.state === 'running';
    let started = false;
    // A root space starts only with a passkey confirmation, which a delete does not ask for: its
    // chats count as not saved, and the user can delete anyway or start it and delete again.
    if (!running && space.state === 'exited' && placeKindOf(space.placeId) !== ROOT_PLACE_KIND) {
      try {
        await manager.startSpace({ spaceId: space.id });
        running = true;
        started = true;
      } catch (error) {
        logger.warn?.(`[spaces] space ${space.id} did not start to give its chats: ${errorSummary(error)}`);
      }
    }
    try {
      return await archiveChats({ spaceId: space.id, name: space.name, projectDirectory: space.projectDirectory ?? null, running, allowUnsaved });
    } catch (error) {
      if (started) {
        await manager.stopSpace({ spaceId: space.id }).catch((stopError) => {
          logger.warn?.(`[spaces] space ${space.id} started for its chats is still running: ${stopError?.code ?? stopError?.message ?? stopError}`);
        });
      }
      throw error;
    }
  };

  const removeAndForget = async (spaceId: string, { allowUnsaved = false } = {}) => {
    const waiting = pending.get(spaceId);
    if (waiting) {
      if (waiting.state !== 'failed') throw new SpaceError('space_preparing', 'This space is still being made. Wait for it, then remove it.');
      pending.delete(spaceId);
      const still = (await listAll()).spaces.some((space) => space.id === spaceId);
      if (!still && !waiting.failure?.cleanup?.length) return { id: spaceId, removed: true, refsRemoved: null, failures: [], chats: null };
      return { id: spaceId, ...(await removeEverything(spaceId, waiting.sourceDirectory, waiting.source, waiting.trustedMigrationPath)), chats: null };
    }
    const retained = records.read(spaceId).record;
    const space = await requireListed(spaceId).catch((error) => {
      if (spaceErrorProperty(error, 'code') === 'space_not_found' && retained?.source && retained.repository) return null;
      throw error;
    });
    if (!space) {
      const remembered = transferValue(retained, 'repository');
      return { id: spaceId, ...(await removeEverything(spaceId, remembered.repository, remembered.source, remembered.trustedMigrationPath)), chats: null };
    }
    // A creation that a previous host did not live to finish is a failed creation too: no chat
    // could have run in it, so nothing is saved and the archive is not asked.
    const chats = space.state === 'failed' ? null : await saveChatsOf(space, allowUnsaved);
    const { record, status } = records.read(spaceId);
    const outcome = await removeEverything(spaceId, status === 'unreadable' ? null : record?.repository ?? space.projectDirectory);
    onSpacesChanged();
    return { id: spaceId, ...outcome, chats };
  };
  const removeUnlocked = (spaceId: string, options?: { allowUnsaved?: boolean }) => removeAndForget(spaceId, options).then((outcome) => { if (outcome.removed) announce(spaceId, { type: 'openchamber:space-progress', properties: { spaceId, step: 'removed', failure: null, timestamp: now().getTime() } }); return outcome; });
  const removeSpace = (spaceId: string, options?: { allowUnsaved?: boolean }) => exclusive(spaceId, () => removeUnlocked(spaceId, options));

  const stopAllSpaces = async () => {
    const preparing = Array.from(pending.values()).filter((entry) => entry.state === 'preparing');
    if (preparing.length > 0) throw new SpaceError('space_preparing', `${preparing.length === 1 ? 'A space is' : `${preparing.length} spaces are`} still being made. Wait for that to finish first.`, { spaces: preparing.map((entry) => entry.id) });
    closing = true;
    let spaces;
    let unavailable;
    try {
      ({ spaces, unavailable } = await listAll());
    } catch (error) {
      logger.warn?.(`[spaces] turning off without knowing which spaces run: ${errorSummary(error)}`);
      return { stopped: [], stillRunning: [], unknown: failureOf(error) };
    }
    const stopped = [];
    const stillRunning = [];
    for (const space of spaces) {
      if (space.state === 'unreachable') {
        const failure = unavailable.find((entry) => entry.placeId === space.placeId)?.failure;
        stillRunning.push({ id: space.id, name: space.name, ...failureOf(failure) });
        continue;
      }
      if (space.state !== 'running') {
        if (space.gatekeeperRunning === true && !busy.has(space.id)) await manager.stopSpace({ spaceId: space.id }).catch(() => {});
        continue;
      }
      try {
        await manager.stopSpace({ spaceId: space.id });
        stopped.push({ id: space.id, name: space.name });
      } catch (error) {
        stillRunning.push({ id: space.id, name: space.name, ...failureOf(error) });
      }
    }
    return unavailable.length === 0 ? { stopped, stillRunning } : { stopped, stillRunning, unknown: failureOf(transferValue(unavailable[0], 'failure').failure) };
  };

  const readIdleStopSetting = () => readIdleStop();

  const changeIdleStop = <Request>(request: Request) => {
    const parsed = idleStopSchema.safeParse(request ?? {});
    if (!parsed.success) return Promise.reject(new SpaceError('invalid_idle_stop', 'The idle stop is on or off, with a whole number of hours from 1 to 168.'));
    const setting = parsed.data;
    const change = settingsTurn.then(async () => {
      await saveIdleStop(setting);
      await tellRunningSpaces((spaceId) => writeIdleStop(spaceId, setting));
      return setting;
    });
    settingsTurn = change.catch(() => {});
    return change;
  };

  const tellRunningSpaces = async (write: (spaceId: string) => Promise<void>) => {
    const { spaces } = await listAll();
    for (const space of spaces) {
      if (space.state === 'running' && !pending.has(space.id)) await write(space.id);
    }
  };

  const changePermissionDefault = (value: Parameters<typeof permissionDefaultOf>[0]) => {
    const setting = permissionDefaultOf(value);
    const change = settingsTurn.then(() => tellRunningSpaces((spaceId) => writePermissionDefault(spaceId, setting)));
    settingsTurn = change.catch(() => {});
    return change;
  };

  const readDisk = async (placeId: string) => requirePlace(placeId).readDisk();

  const cleanUpDisk = async (placeId: string) => {
    const place = requirePlace(placeId);
    if (Array.from(pending.values()).some((entry) => entry.state === 'preparing')) {
      throw new SpaceError('space_preparing', 'A space is being made. Clean up when it is ready.');
    }
    if (place.imagePulling()) {
      throw new SpaceError('image_pulling', 'The image is being downloaded. Clean up when it is done.');
    }
    const { freedBytes, kept, machine } = await place.cleanUpDisk();
    for (const item of kept.filter((entry) => 'reason' in entry && entry.reason === 'failed')) {
      logger.warn?.(`[spaces] clean-up could not remove ${item.kind} ${item.name}: ${item.message}`);
    }
    if (machine.state === 'failed') logger.warn?.(`[spaces] the Colima machine did not trim its disk: ${spaceErrorProperty(machine, 'message')}`);
    if (machine.state === 'trimmed') logger.info?.('[spaces] the Colima machine trimmed its disk after a clean-up');
    return { freedBytes, kept: kept.map((item) => ({ kind: item.kind, reason: 'reason' in item ? item.reason : undefined })), disk: await place.readDisk() };
  };

  const pullImage = async (placeId: string) => {
    const place = requirePlace(placeId);
    place.pullImage().catch(<Cause>(error: Cause) => { logger.warn?.(`[spaces] the image download failed: ${transferErrorProperty(error, 'code') ?? transferErrorProperty(error, 'message')}`); });
    return place.readDisk();
  };

  const reopen = () => { closing = false; };

  const isIdle = () => busy.size === 0 && Array.from(pending.values()).every((entry) => entry.state !== 'preparing');

  const readJournal = (spaceId: string) => exclusive(spaceId, async () => {
    const space = await requireListed(spaceId);
    if (space.state !== 'running') {
      throw new SpaceError('space_not_running', 'The journal lives in the memory of the space\'s gatekeeper and is gone with a stop. Start the space to record new attempts.');
    }
    return gatekeeper.readJournal(spaceId);
  });

  const requireRepository = async (spaceId: string) => {
    requireNotPending(spaceId);
    const space = await requireListed(spaceId);
    const { record, status } = records.read(spaceId);
    if (status === 'unreadable') throw new SpaceError('space_record_unreadable', 'The space record cannot be read.');
    const repository = record?.repository ?? space.projectDirectory;
    if (!repository) throw new SpaceError('project_not_registered', 'The project this space was made for is no longer registered, so its work has nowhere to go.');
    if (space.state !== 'running') throw new SpaceError('space_not_running', 'The space is stopped. Start it to apply its work.');
    const result = { space, repository, spacePath: record?.spacePath ?? space.directory, source: record?.source, trustedMigrationPath: record?.trustedMigrationPath };
    return result;
  };

  /** Brings the work out and describes what an apply would do, for the apply dialog. */
  const previewApply = (spaceId: string) => exclusive(spaceId, async () => {
    const { repository, spacePath, source, trustedMigrationPath } = await requireRepository(spaceId);
    const input = { repository, spaceId, source, trustedMigrationPath };
    const brought = await codeOut.bringCodeOut({ ...input, spacePath });
    const state = await codeOut.describeApplyState(input);
    return { ...brought, ...state };
  });

  const applySpace = <Request>(spaceId: string, request: Request) => exclusive(spaceId, async () => {
    const parsed = applyRequestSchema.safeParse(request ?? {});
    if (!parsed.success) throw new SpaceError('invalid_apply_request', 'The work is applied as a branch, with its name, or as uncommitted changes.');
    const { as, removeAfterwards } = parsed.data;
    const branch = as === 'branch' ? parsed.data.branch : null;
    const { repository, spacePath, source, trustedMigrationPath } = await requireRepository(spaceId);
    const input = { repository, spaceId, source, trustedMigrationPath };
    const brought = await codeOut.bringCodeOut({ ...input, spacePath });
    const applied = as === 'branch'
      ? { status: 'applied', ...(await codeOut.applyAsBranch({ ...input, branch: transferValue(branch) })) }
      : await codeOut.applyAsChanges(input);
    let removal = null;
    let kept = null;
    if (removeAfterwards && applied.status === 'applied') {
      try {
        removal = await removeUnlocked(spaceId);
      } catch (error) {
        if (spaceErrorProperty(error, 'code') !== 'chats_not_saved') throw error;
        kept = failureOf(error);
      }
    }
    return { brought, applied, removal, kept };
  });

  // Server-only. The caller owns and verifies sourceDirectory as its item worktree.
  const createBotSpace = <Request>(request: Request, { sourceDirectory, source, onAllocated }: InternalCreation) => createSpace(request, { sourceDirectory, source, onAllocated, waitUntilReady: true });
  return { createSpace, createBotSpace, rootActivationOptions, readRootPasskeys, rootApprovalChallenge, completeRootApproval, listSpaces, setTaskTitle, startSpace, stopSpace, restartSpace, restartOpenCode, removeSpace, stopAllSpaces, reopen, isIdle, grantAccess, sayLogin, readHostLogins, readHostCustomProviders, readHostCatalogProviders: modelGrants.listCatalogProviders, openDomain, restoreLostGrants, readJournal, previewApply, applySpace, readIdleStopSetting, changeIdleStop, changePermissionDefault, runSetup, readSetup, readDisk, cleanUpDisk, pullImage };
}
