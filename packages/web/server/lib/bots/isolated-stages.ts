import { OpenCode } from '@opencode/client';
import { z } from 'zod';
import { createSessionActivityProbe } from '../opencode/session-activity.js';
import { createTokenSnapshotReader } from '../pr-fix-loop/token-usage.js';
import { unwrapOpenCodeResponse } from '../opencode/response-envelope.js';
import { readDispatchOutcome } from '../dispatch-results/runtime.js';
import { buildKnowledgeEntries } from '../session-knowledge/runtime.js';
import { buildGoalIntroText } from '../session-goal/create.js';
import { digestMutationInput } from '../source-control/mutation-executor.js';
import { createBotAdapterState } from './adapter-state.js';
import { botStagePermissions } from './stage-sessions.js';
import { BotServiceError } from './services/contracts.js';
import { readBotSpaceOptions } from './space-options.js';
import { isolatedBotToolPageSchema, isolatedBotToolReceiptSchema } from './isolated-tools.js';
import { botSpaceFetch, botSpaceArtifactTransport } from './isolated-transport.js';
import type { IsolatedStagesOptions, IsolatedSpacesHost, StageRequest, DispatchRequest, StageModel, RunningRequest, OutcomeRequest, ReconcileRequest, BindingQuery, ItemKey, Project, SpaceOptions, SpaceOptionsRequest, CreationTransfer, OnCreated, Reconciliation, ToolReply, ProofInput, ProofCancellation } from './isolated-stages.types.js';
import { hasProperties, isRecord } from '../shared/object-guards.js';

const text = z.string().min(1);
const spaceOptionsSchema = z.object({
  placeId: text.optional(), network: z.object({ mode: z.enum(['allowlist', 'open']), domains: z.array(text) }).default({ mode: 'allowlist', domains: [] }),
  setupCommands: z.array(text).default([]), grants: z.array(z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('login'), provider: text }).strict(),
    z.object({ kind: z.literal('custom'), provider: text }).strict(),
    z.object({ kind: z.literal('model'), provider: text, upstream: text, secret: z.object({ kind: z.literal('env'), name: text }).strict() }).strict(),
  ])).min(1),
}).strict();
const sessionSchema = z.object({ id: text, stage: z.enum(['investigation', 'fixing', 'judge']), directory: text }).strict();
const bindingSchema = z.object({ version: z.literal(1), projectId: text, itemId: text, botId: text,
  hostDirectory: text, state: z.enum(['creating', 'ready', 'stopping', 'stopped', 'resuming', 'removing', 'remove-failed', 'removed']), spaceId: z.string().regex(/^[a-f0-9]{12}$/).optional(),
  directory: text.optional(), sessions: z.record(z.string(), sessionSchema), artifactsCollected: z.boolean().optional(),
}).strict();
type Binding = z.output<typeof bindingSchema>;
type AllocatedBinding = Binding & { spaceId: string; directory: string };
const keyFor = ({ projectId, itemId }: ItemKey) => ({ projectId, itemId });
const runKey = (request: Pick<ReconcileRequest, 'stage' | 'dispatchedAt' | 'prompt'>) => digestMutationInput({ stage: request.stage, dispatchedAt: request.dispatchedAt, prompt: request.prompt });
const refuse: (code: string) => never = (code) => { throw new BotServiceError(code, 'The recorded isolated bot space needs attention. No host session or proof was started.'); };
const required = <Value>(value: Value | null | undefined): Value => {
  if (value == null) throw new TypeError('Required isolated stage value is missing');
  return value;
};
const field = <Value>(value: Value, name: string) => hasProperties(value) ? value[name] : undefined;

export async function resolveBotSpaceOptions({ host, project, selection }: { readonly host: IsolatedSpacesHost | null; readonly project: Project; readonly selection: { readonly providerID: unknown; readonly modelID?: unknown } }): Promise<SpaceOptions> {
  if (!host) refuse('BOT_ISOLATION_UNAVAILABLE');
  const provider = z.string().min(1).parse(selection.providerID);
  const custom = z.object({ providers: z.array(z.object({ id: text, supported: z.boolean(), models: z.array(text) })) })
    .parse(await host.journey.readHostCustomProviders(project.path)).providers.find((entry) => entry.id === provider);
  if (custom) {
    if (!custom.supported || !custom.models.some((model) => model === selection.modelID)) refuse('BOT_ISOLATED_MODEL_UNAVAILABLE');
    return { grants: [{ kind: 'custom', provider }] };
  }
  const login = z.object({ logins: z.array(z.object({ provider: text, state: z.enum(['usable', 'expired', 'unsupported']) })) })
    .parse(await host.journey.readHostLogins()).logins.find((entry) => entry.provider === provider);
  if (login?.state === 'usable') return { grants: [{ kind: 'login', provider }] };
  const approved = new Map<string, z.output<typeof spaceOptionsSchema>['grants'][number]>();
  for (const space of await host.journey.listSpaces({ access: true })) {
    if (space.projectDirectory !== project.path || space.state !== 'running' || space.access !== 'granted') continue;
    for (const grant of space.grants) {
      if (grant.kind !== 'model' || grant.provider !== provider || grant.source.kind !== 'env') continue;
      const request = required(spaceOptionsSchema.parse({ grants: [{ kind: 'model', provider, upstream: grant.upstream, secret: { kind: 'env', name: grant.source.name } }] }).grants[0]);
      approved.set(digestMutationInput(request), request);
    }
  }
  if (approved.size !== 1) refuse(approved.size ? 'BOT_ISOLATED_MODEL_GRANT_AMBIGUOUS' : 'BOT_ISOLATED_MODEL_GRANT_REQUIRED');
  return { grants: [...approved.values()] };
}

export const BOT_ISOLATED_PROOF_PROGRAM = `
const fs = require('node:fs'); const path = require('node:path'); const cp = require('node:child_process');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const result = {status:'inconclusive',testSha:input.testSha,fixSha:input.fixSha,command:input.command,args:input.args,testExitCode:null,fixExitCode:null};
const git = (args) => cp.spawnSync('/usr/bin/git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-C',input.directory,...args],{encoding:'utf8',timeout:30000,maxBuffer:4194304});
let root; const checkouts=[];
try {
  if (input.testSha === input.fixSha || git(['merge-base','--is-ancestor',input.testSha,input.fixSha]).status !== 0) throw Error('Invalid proof ancestry.');
  const changed=git(['diff-tree','--root','--no-commit-id','--name-only','--no-renames','-r','-z',input.testSha,'--']);
  if (changed.status !== 0) throw Error('Test files could not be read.');
  const files=changed.stdout.split('\\0').filter(Boolean); if (!files.length) throw Error('Test commit changes no files.');
  result.args=input.args.flatMap(arg=>arg === '{files}' ? files : [arg]);
  root=fs.mkdtempSync('/tmp/openchamber-bot-proof-');
  for (const [name,sha] of [['test',input.testSha],['fix',input.fixSha]]) {
    const directory=path.join(root,name);
    if (git(['worktree','add','--detach',directory,sha]).status !== 0) throw Error('Proof snapshot could not be created.');
    checkouts.push(directory);
    const run=cp.spawnSync(input.command,result.args,{cwd:directory,shell:false,timeout:120000,maxBuffer:4194304,stdio:['ignore','pipe','pipe']});
    const code=!run.error && !run.signal && Number.isInteger(run.status) && ![126,127].includes(run.status) ? run.status : null;
    result[name+'ExitCode']=code;
    if (code === null) throw Error('Test process did not complete.');
  }
  result.status=result.testExitCode !== 0 && result.fixExitCode === 0 ? 'passed' : 'failed';
} catch { result.reason='Isolated proof did not establish a failing test followed by a passing fix.'; }
finally { for (const dir of checkouts.reverse()) { if (git(['worktree','remove','--force',dir]).status !== 0) {result.status='inconclusive';result.reason='Proof snapshot cleanup failed.';} } if(root) fs.rmSync(root,{recursive:true,force:true}); }
process.stdout.write(JSON.stringify(result));
`;

export function createBotIsolatedStages({ dataDir, getSpacesHost, resolveProject,
  resolveSpaceOptions = (request: SpaceOptionsRequest) => resolveBotSpaceOptions({ host: getSpacesHost(), ...request }), sessionKnowledgeRuntime, handleTool, readToolOutcome, collectArtifacts, separated = false }: IsolatedStagesOptions) {
  for (const value of [getSpacesHost, resolveProject, resolveSpaceOptions, sessionKnowledgeRuntime?.collect]) if (!(value instanceof Function)) throw new TypeError('Isolated stages require spaces, project, grants and knowledge owners');
  const records = createBotAdapterState({ dataDir, name: 'isolated-stages', schema: bindingSchema });
  const toolReceipts = createBotAdapterState({ dataDir, name: 'isolated-tool-receipts', schema: isolatedBotToolReceiptSchema });
  const hostFor = () => { const host = getSpacesHost(); if (!host) refuse('BOT_ISOLATION_UNAVAILABLE'); return host; };
  const find = async (request: BindingQuery): Promise<AllocatedBinding> => {
    const matches = (await records.list()).filter((record) => request.projectId && request.itemId
      ? record.projectId === request.projectId && record.itemId === request.itemId
      : request.sessionId ? Object.values(record.sessions).some((session) => session.id === request.sessionId)
        : record.hostDirectory === request.directory);
    const binding = matches[0];
    if (matches.length !== 1 || !binding?.spaceId || !binding.directory) refuse('BOT_ISOLATED_BINDING_REQUIRED');
    return { ...binding, spaceId: binding.spaceId, directory: binding.directory };
  };
  const requireReady = async (binding: Binding) => {
    if (binding.state !== 'ready') refuse('BOT_ISOLATED_CREATE_UNKNOWN');
    const host = hostFor();
    const space = (await host.journey.listSpaces({ access: true })).find((entry) => entry.id === binding.spaceId);
    if (!space || space.state !== 'running' || space.access !== 'granted' || space.accessFailures?.length || space.damaged) refuse('BOT_ISOLATED_SPACE_UNAVAILABLE');
    if ((await host.manager.verify(required(binding.spaceId))).length) refuse('BOT_ISOLATED_SPACE_UNVERIFIED');
    return host;
  };
  const ownerFor = async (binding: Binding) => {
    const host = await requireReady(binding);
    const fetchImpl = botSpaceFetch(host, required(binding.spaceId));
    const baseUrl = 'http://space.invalid';
    const client = OpenCode.make({ baseUrl, headers: { 'x-opencode-directory': encodeURIComponent(required(binding.directory)) }, fetch: fetchImpl });
    const probe = createSessionActivityProbe({ buildOpenCodeUrl: (route: string) => baseUrl + route, getOpenCodeAuthHeaders: () => ({}), fetchImpl });
    const tokens = createTokenSnapshotReader({ buildOpenCodeUrl: (route: string) => baseUrl + route, getOpenCodeAuthHeaders: () => ({}), fetchImpl });
    return { host, client, probe, tokens, fetchImpl, baseUrl };
  };
  const configure = async (request: Pick<RunningRequest, 'bot' | 'stage' | 'sessionId'>, binding: Binding, owner: Awaited<ReturnType<typeof ownerFor>>) => {
    await owner.client.session.update({ sessionID: request.sessionId, permissions: botStagePermissions(request.stage, request.bot) });
    const mode = request.stage === 'fixing' ? request.bot.permissionMode : 'ask';
    if (mode !== 'default') await owner.fetchImpl(`${owner.baseUrl}/api/permission-auto-accept/sessions/${encodeURIComponent(request.sessionId)}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode, directory: binding.directory }),
    });
    const entries = buildKnowledgeEntries(await sessionKnowledgeRuntime.collect(binding.hostDirectory), { includeMemorySaveRule: request.stage === 'fixing' });
    for (const [key, value] of Object.entries(entries)) if (value) await owner.client.session.instructions.entry.put({ sessionID: request.sessionId, key, value });
  };
  const create = async (request: StageRequest, onCreated: OnCreated) => records.own(keyFor(request), async () => {
    const selection = request.selection;
    const host = hostFor(); const key = keyFor(request);
    let binding = await records.read(key);
    if (!binding) {
      const project = await resolveProject(request.projectId);
      const options = spaceOptionsSchema.parse(await resolveSpaceOptions({ project, bot: request.bot, selection: request.selection, stage: request.stage }));
      if (options.grants.length !== 1 || required(options.grants[0]).provider !== selection.providerID) refuse('BOT_ISOLATED_MODEL_GRANT_REQUIRED');
      binding = await records.write(key, { version: 1, projectId: request.projectId, itemId: request.itemId, botId: request.bot.id,
        hostDirectory: request.directory, state: 'creating', sessions: {} });
      const transfer: CreationTransfer = {
        sourceDirectory: request.directory,
        onAllocated: async ({ id, directory }) => { binding = await records.write(key, { ...binding, spaceId: id, directory }); },
      };
      if (separated) transfer.source = request.itemId.startsWith('discovery_') ? { kind: 'project', directory: project.path }
        : { kind: 'bot-checkout', projectDirectory: project.path, projectId: request.projectId,
          botId: request.bot.id, itemId: request.itemId, checkoutKey: `${request.itemId}:worktree` };
      await host.journey.createBotSpace({ ...options, projectDirectory: project.path, name: `${request.bot.name}: ${request.itemId}`, start: 'clean' }, transfer);
      binding = await records.write(key, { ...binding, state: 'ready' });
    }
    if (binding.state !== 'ready') refuse('BOT_ISOLATED_CREATE_UNKNOWN');
    const owner = await ownerFor(binding);
    const spaceId = binding.spaceId;
    const space = (await host.journey.listSpaces({ access: true })).find((entry) => entry.id === spaceId);
    if (!required(space).grants.some((grant) => 'provider' in grant && grant.provider === selection.providerID)) {
      const project = await resolveProject(request.projectId);
      const options = spaceOptionsSchema.parse(await resolveSpaceOptions({ project, bot: request.bot, selection: request.selection, stage: request.stage }));
      const grants = options.grants.filter((grant) => grant.provider === selection.providerID);
      if (grants.length !== 1) refuse('BOT_ISOLATED_MODEL_GRANT_REQUIRED');
      await host.journey.grantAccess(required(binding.spaceId), grants[0]);
    }
    let session = binding.sessions[runKey(request)];
    if (!session) {
      const id = `ses_bot${digestMutationInput({ item: keyFor(binding), run: runKey(request) }).slice(0, 26)}`;
      session = { id, stage: request.stage, directory: required(binding.directory) };
      binding = await records.write(key, { ...binding, sessions: { ...binding.sessions, [runKey(request)]: session } });
      const created = z.object({ id: text, location: z.object({ directory: text }) }).parse(unwrapOpenCodeResponse(await owner.client.session.create({
        id,
        location: { directory: required(binding.directory) }, title: `${request.bot.name}: ${request.stage}`, permissions: botStagePermissions(request.stage, request.bot),
        metadata: { openchamber: { kind: 'scheduled', automation: { source: 'bot', projectId: request.projectId, botId: request.bot.id, itemId: request.itemId, stage: request.stage, notify: request.bot.notify } } },
      })));
      if (created.id !== id || created.location.directory !== binding.directory) refuse('BOT_ISOLATED_DIRECTORY_MISMATCH');
    }
    await onCreated({ sessionId: session.id, directory: required(binding.directory) });
    await configure({ ...request, sessionId: session.id }, binding, owner);
    return { sessionId: session.id, directory: required(binding.directory) };
  });
  const dispatch = async (request: DispatchRequest) => {
    const sessionId = required(request.sessionId);
    const binding = await find(request); const owner = await ownerFor(binding);
    if (!Object.values(binding.sessions).some((session) => session.id === request.sessionId)) refuse('BOT_ISOLATED_SESSION_MISMATCH');
    if (binding.artifactsCollected) await records.write(keyFor(binding), { ...binding, artifactsCollected: false });
    await configure({ ...request, sessionId }, binding, owner);
    const { providerID, modelID, agent, variant } = request.selection;
    const model: StageModel = { providerID, id: modelID };
    if (variant) model.variant = variant;
    await owner.client.session.switchModel({ sessionID: sessionId, model });
    if (agent) await owner.client.session.switchAgent({ sessionID: sessionId, agent });
    if (request.stage === 'fixing' && request.bot.goalTokenBudget) {
      const at = Date.now();
      await owner.fetchImpl(`${owner.baseUrl}/api/openchamber/sessions/${encodeURIComponent(sessionId)}/metadata`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ directory: binding.directory, patch: { openchamber: { goal: {
          id: runKey(request), objective: request.prompt.slice(0, 5_000), objectiveFile: false, status: 'active', tokenBudget: request.bot.goalTokenBudget,
          tokensUsed: 0, turnsUsed: 0, blockedStreak: 0, note: '', statusReason: '', lastAccountedMessageID: '', createdAt: at, updatedAt: at,
        } } } }),
      });
    }
    await owner.client.session.prompt({ sessionID: sessionId, id: `msg_${digestMutationInput({ sessionId: request.sessionId, run: runKey(request) }).slice(0, 26)}`, text: request.prompt });
    if (request.stage === 'fixing' && request.bot.goalTokenBudget) await owner.client.session.synthetic({ sessionID: sessionId, text: buildGoalIntroText(request.bot.goalTokenBudget), resume: false });
    return { id: sessionId, sessionId };
  };
  const outcome = async (request: OutcomeRequest) => {
    const sessionId = required(request.sessionId);
    const binding = await find(request); const owner = await ownerFor(binding);
    const statuses = await owner.probe.fetchActiveSessionStatuses();
    if (statuses === null) refuse('BOT_ISOLATED_ACTIVITY_UNAVAILABLE');
    if (statuses[sessionId]) return null;
    const children = await owner.probe.hasWorkingDescendants(sessionId, statuses);
    if (children === null) refuse('BOT_ISOLATED_ACTIVITY_UNAVAILABLE');
    if (children) return null;
    const page = z.object({ data: z.array(z.json()) }).parse(await owner.client.message.list({ sessionID: sessionId, limit: 100, order: 'desc' }));
    const result = readDispatchOutcome(page.data, request.dispatchedAt, request.afterIdleId);
    if (!result) return null;
    if (result.state !== 'completed') return result;
    const tokens = z.number().int().nonnegative().parse(await owner.tokens(sessionId, binding.directory));
    return { ...result, tokens };
  };
  const reconcile = async (kind: 'session.create' | 'session.prompt', request: ReconcileRequest, recordedSessionId?: string): Promise<Reconciliation> => {
    const binding = await find(request);
    if (kind === 'session.create') {
      const session = binding.sessions[runKey(request)];
      if (session && (!recordedSessionId || session.id === recordedSessionId)) {
        const { client } = await ownerFor(binding);
        const info = unwrapOpenCodeResponse(await client.session.get({ sessionID: session.id }));
        const marker = field(field(field(info, 'metadata'), 'openchamber'), 'automation');
        if (field(field(info, 'location'), 'directory') === binding.directory && field(marker, 'source') === 'bot' && field(marker, 'itemId') === binding.itemId && field(marker, 'botId') === binding.botId && field(marker, 'stage') === request.stage) return { state: 'succeeded', result: { id: session.id, sessionId: session.id } };
      }
    } else if (kind === 'session.prompt' && await outcome(request)) return { state: 'succeeded', result: { id: required(request.sessionId), sessionId: required(request.sessionId) } };
    return { state: 'outcome-unknown' };
  };
  const removalGone = async (host: IsolatedSpacesHost, binding: Binding) => {
    const { spaces, unavailable } = await host.manager.listAllSpaces();
    if (spaces.some((space) => space.id === binding.spaceId)) return false;
    if (unavailable.length) refuse('BOT_ISOLATED_REMOVE_UNCONFIRMED');
    return true;
  };
  const resume = async (request: RunningRequest) => {
    const found = await find(request);
    return records.own(keyFor(found), async () => {
      let binding = required(await records.read(keyFor(found)));
      if (binding.botId !== request.bot.id || binding.hostDirectory !== request.directory
        || !Object.values(binding.sessions).some((session) => session.id === request.sessionId && session.stage === request.stage)) refuse('BOT_ISOLATED_SESSION_MISMATCH');
      if (!['ready', 'stopping', 'stopped', 'resuming'].includes(binding.state)) refuse('BOT_ISOLATED_CREATE_UNKNOWN');
      const options = spaceOptionsSchema.parse(readBotSpaceOptions(request.bot.space, request.selection));
      const host = hostFor();
      binding = await records.write(keyFor(binding), { ...binding, state: 'resuming', artifactsCollected: false });
      const started = await host.journey.startSpace(required(binding.spaceId));
      if (started.networkRestored !== true) refuse('BOT_ISOLATED_NETWORK_UNCONFIRMED');
      await host.journey.grantAccess(required(binding.spaceId), options.grants[0]);
      await requireReady({ ...binding, state: 'ready' });
      await records.write(keyFor(binding), { ...binding, state: 'ready' });
    });
  };
  const finishArtifacts = async (binding: Binding, final: boolean) => {
    if (!collectArtifacts) return binding;
    const collecting = await records.write(keyFor(binding), { ...binding, artifactsCollected: false });
    const host = hostFor();
    const fetchImpl = botSpaceFetch(host, required(binding.spaceId));
    const client = OpenCode.make({ baseUrl: 'http://space.invalid', fetch: fetchImpl,
      headers: { 'x-opencode-directory': encodeURIComponent(required(binding.directory)) } });
    const probe = createSessionActivityProbe({ buildOpenCodeUrl: (route) => `http://space.invalid${route}`, getOpenCodeAuthHeaders: () => ({}), fetchImpl });
    for (const session of Object.values(binding.sessions)) await client.session.interrupt({ sessionID: session.id });
    const active = await probe.fetchActiveSessionStatuses();
    if (active === null) refuse('BOT_ISOLATED_ACTIVITY_UNAVAILABLE');
    for (const session of Object.values(binding.sessions)) {
      if (active[session.id] || await probe.hasWorkingDescendants(session.id, active) !== false) refuse('BOT_ISOLATED_NOT_STOPPED');
      await collectArtifacts(session.id);
    }
    return final ? records.write(keyFor(binding), { ...collecting, artifactsCollected: true }) : collecting;
  };
  const stop = async (request: BindingQuery) => {
    const found = await find(request);
    return records.own(keyFor(found), async () => {
      let binding = required(await records.read(keyFor(found)));
      if (binding.state === 'removed') return;
      const host = hostFor();
      const removing = ['removing', 'remove-failed'].includes(binding.state);
      if (removing && await removalGone(host, binding)) {
        if (binding.state === 'removing') await records.write(keyFor(binding), { ...binding, state: 'removed' });
        return;
      }
      const producer = (await host.manager.listAllSpaces()).spaces.find((space) => space.id === binding.spaceId);
      if (!producer) refuse('BOT_ISOLATED_STOP_UNCONFIRMED');
      if (!removing) binding = await records.write(keyFor(binding), { ...binding, state: 'stopping' });
      if (!collectArtifacts || (binding.artifactsCollected && producer.state === 'exited')) await host.journey.stopSpace(required(binding.spaceId));
      else await host.journey.cleanupBotSpace(required(binding.spaceId), { remove: false, collect: async (final) => { binding = await finishArtifacts(binding, final); } });
      const space = (await host.journey.listSpaces()).find((entry) => entry.id === binding.spaceId);
      if (!space || space.state !== 'exited') refuse('BOT_ISOLATED_STOP_UNCONFIRMED');
      if (!removing) await records.write(keyFor(binding), { ...binding, state: 'stopped' });
    });
  };
  const executeIsolatedProof = async (input: ProofInput, { signal }: ProofCancellation = {}) => {
    signal?.throwIfAborted();
    const binding = await find(input); const host = await requireReady(binding);
    const result = await host.manager.exec(binding.spaceId, ['/usr/bin/timeout', '-s', 'KILL', '300', '/usr/local/bin/node', '-e', BOT_ISOLATED_PROOF_PROGRAM], {
      stdin: JSON.stringify({ ...input, directory: binding.directory }), timeoutMs: 330_000, maxOutputBytes: 128 * 1024, killTree: true, signal,
    });
    signal?.throwIfAborted();
    if (result.code !== 0) refuse('BOT_ISOLATED_PROOF_FAILED');
    const parsed = z.object({ status: z.enum(['passed', 'failed', 'inconclusive']), testSha: text, fixSha: text, command: text,
      args: z.array(z.string()), testExitCode: z.number().int().nullable(), fixExitCode: z.number().int().nullable(), reason: text.optional() }).strict().parse(JSON.parse(result.stdout));
    if (parsed.testSha !== input.testSha || parsed.fixSha !== input.fixSha || parsed.command !== input.command) refuse('BOT_ISOLATED_PROOF_MISMATCH');
    return parsed;
  };
  const exportSnapshot = async (request: BindingQuery) => {
    const binding = await find(request); const host = await requireReady(binding);
    const result = await host.journey.previewApply(binding.spaceId);
    const resultSha = z.string().regex(/^[a-f0-9]{40}$/).parse(result.result);
    return { spaceId: binding.spaceId, directory: binding.directory, repository: binding.hostDirectory, resultSha };
  };
  const forwardTools = async ({ spaceId, sessionId }: { readonly spaceId: string; readonly sessionId: string }) => {
    if (!(handleTool instanceof Function)) refuse('BOT_ISOLATED_TOOL_OWNER_REQUIRED');
    const binding = await find({ sessionId });
    if (binding.spaceId !== spaceId || !Object.values(binding.sessions).some((session) => session.id === sessionId && session.stage === 'fixing')) refuse('BOT_ISOLATED_TOOL_SESSION_REQUIRED');
    const owner = await ownerFor(binding);
    const info = unwrapOpenCodeResponse(await owner.client.session.get({ sessionID: sessionId }));
    const marker = field(field(field(info, 'metadata'), 'openchamber'), 'automation');
    if (field(field(info, 'location'), 'directory') !== binding.directory || field(marker, 'source') !== 'bot' || field(marker, 'itemId') !== binding.itemId || field(marker, 'botId') !== binding.botId || field(marker, 'stage') !== 'fixing') refuse('BOT_ISOLATED_TOOL_SESSION_REQUIRED');
    const response = await owner.fetchImpl(`${owner.baseUrl}/api/openchamber/bots/isolated-tools?${new URLSearchParams({ sessionId })}`);
    const page = isolatedBotToolPageSchema.parse(await response.json());
    if (page.requests.some((entry) => entry.request.sessionId !== sessionId
      || entry.id !== digestMutationInput({ sessionId, callId: entry.request.callId }))) refuse('BOT_ISOLATED_TOOL_SESSION_REQUIRED');
    let forwarded = 0;
    for (const entry of page.requests) {
      const key = { spaceId, sessionId, id: entry.id };
      await toolReceipts.own(key, async () => {
        let receipt = await toolReceipts.read(key);
        if (receipt && digestMutationInput(receipt.request) !== digestMutationInput(entry.request)) refuse('BOT_ISOLATED_TOOL_CHANGED');
        if (receipt?.state === 'dispatching') {
          const recovered = await readToolOutcome?.(receipt.request);
          if (recovered?.state !== 'succeeded') refuse('BOT_ISOLATED_TOOL_OUTCOME_UNKNOWN');
          receipt = await toolReceipts.write(key, { ...entry, state: 'settled', reply: { ok: true, result: recovered.result } });
        }
        if (!receipt) {
          await toolReceipts.write(key, { ...entry, state: 'dispatching' });
          let reply: ToolReply;
          try { reply = { ok: true, result: z.json().parse(await handleTool({ sessionId, action: entry.request.action, input: entry.request.input })) }; }
          catch (error) {
            const failure = z.object({ code: z.string().regex(/^BOT_[A-Z0-9_]+$/).max(200), status: z.number().int().min(400).max(599), state: z.enum(['needs-you', 'outcome-unknown', 'failed', 'refused']).default('needs-you') }).safeParse(error);
            reply = { ok: false, error: failure.success ? failure.data : { code: 'BOT_ISOLATED_TOOL_REFUSED', status: 409, state: 'needs-you' } };
          }
          receipt = await toolReceipts.write(key, { ...entry, state: 'settled', reply });
        }
        if (receipt.state !== 'settled') refuse('BOT_ISOLATED_TOOL_OUTCOME_UNKNOWN');
        await owner.fetchImpl(`${owner.baseUrl}/api/openchamber/bots/isolated-tools/settle`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...entry, reply: receipt.reply }),
        });
        forwarded++;
      });
    }
    return { forwarded };
  };
  const sessionOwner = async ({ sessionId }: { readonly sessionId: string }) => {
    const binding = await find({ sessionId });
    const owner = await ownerFor(binding);
    const raw = required(unwrapOpenCodeResponse(await owner.client.session.get({ sessionID: sessionId })));
    const info = isRecord(raw) ? raw : {};
    const session = required(Object.values(binding.sessions).find((entry) => entry.id === sessionId));
    const marker = field(field(field(info, 'metadata'), 'openchamber'), 'automation');
    if (info.id !== sessionId || !isRecord(info.location) || info.location.directory !== binding.directory || field(marker, 'source') !== 'bot'
      || field(marker, 'projectId') !== binding.projectId || field(marker, 'itemId') !== binding.itemId || field(marker, 'botId') !== binding.botId
      || field(marker, 'stage') !== session.stage) refuse('BOT_ISOLATED_SESSION_MISMATCH');
    return { ...owner, binding, info: { ...info, id: info.id, location: { ...info.location, directory: info.location.directory } } };
  };
  const remove = async ({ project, bot, item }: { readonly project: Pick<Project, 'id'>; readonly bot: Pick<StageRequest['bot'], 'id'>; readonly item: { readonly id: string; readonly worktree?: string | undefined } }) => records.own({ projectId: project.id, itemId: item.id }, async () => {
    const key = { projectId: project.id, itemId: item.id };
    const recorded = await records.read(key);
    if (!recorded) return;
    let binding = recorded;
    if (binding.botId !== bot.id || binding.hostDirectory !== item.worktree || !binding.spaceId) refuse('BOT_ISOLATED_BINDING_REQUIRED');
    if (binding.state === 'removed') return;
    const host = hostFor();
    if (['removing', 'remove-failed'].includes(binding.state) && await removalGone(host, binding)) {
      if (binding.state === 'remove-failed') refuse('BOT_ISOLATED_REMOVE_UNCONFIRMED');
      await records.write(key, { ...binding, state: 'removed' });
      return;
    }
    binding = await records.write(key, { ...binding, state: 'removing' });
    const result = required(await host.journey.cleanupBotSpace(required(binding.spaceId), { remove: true, collect: async (final) => { binding = await finishArtifacts(binding, final); } }));
    if (!result.removed || result.failures?.length) {
      await records.write(key, { ...binding, state: 'remove-failed' });
      refuse('BOT_ISOLATED_REMOVE_UNCONFIRMED');
    }
    await records.write(key, { ...binding, state: 'removed' });
  });
  return { create, dispatch, outcome, reconcile, stop, resume, remove, sessionOwner, executeIsolatedProof,
    artifactTransport: async (sessionId: string) => {
      const binding = await find({ sessionId });
      return botSpaceArtifactTransport(hostFor(), binding.spaceId);
    },
    bindings: records.list, readBinding: (request: ItemKey) => records.read(keyFor(request)), bindingFor: find, exportSnapshot, forwardTools };
}
