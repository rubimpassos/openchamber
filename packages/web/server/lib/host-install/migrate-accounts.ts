import fs from 'node:fs/promises';
import path from 'node:path';
import { pickAgentSettings } from '../agent-server/settings-mirror.js';
import { isRecord, isString } from '../shared/guards.js';
import { fail, FRONT_HOME } from './accounts.js';
import { hasCode } from './host-inputs.js';
import type { JsonValue } from './host-inputs.js';
import { readOptionalText as readOptional } from './host-files.js';
import { oldDataDirectory } from './host-paths.js';
import { AGENT_BOT_RECORDS, copyEntry, entries, isMigrationObject, ownTree, readOwned, requirePhysicalDirectory } from './migration-copy.js';
import { FIX_LOOPS, splitBotControl, splitFixLoops, splitProjects } from './migration-projects.js';
import { splitMessageQueue } from './migration-queue.js';
import { retainBotWorktrees } from './migration-worktrees.js';
import type { MigrateAccountsOptions, MigrationContext, MigrationManifest, MigrationFile, MigrationValue, ProjectSharing, RefusedProject } from './migration-types.js';
export { ownTree, requirePhysicalDirectory } from './migration-copy.js';
export { readOptionalText as readOptional } from './host-files.js';
export { oldDataDirectory } from './host-paths.js';

const AGENT = new Set(('agent-tool chats dispatch-results.json extensions extensions.json extensions-deploy.json github-auth.json goals guest-services guest-storage managed-opencode mcp-project-local memory.json message-queue.json opencode-trust.json opencode.managed.json pr-fix-loops.json pr-watch.json projects project-icons session-drafts session-drafts.json session-warming.json sessions-archive.json sessions-directories.json sessions-unread.json skills-catalog-cache.json skills-github-meta.json source-control-audit.json source-control-mutations.json source-control-bindings.json tracked-items.json walkthroughs classification.json bot-identities.json bot-worktrees').split(' '));
const FRONT = new Set(('settings.json ui-passkeys.json jwt-secret client-pairing-sessions.json remote-clients.json relay-identity.json apns-tokens.json notification-center.json notification-center-version.json spaces mcp-protected preferences.json voice-keys.json speech-models bots bot-provider-events.json').split(' '));
const SKIP = new Set(['cache', 'tmp', 'run', 'logs', 'bin', 'update-install.log']);
export const classify = (name: string) => {
  if (SKIP.has(name) || name.endsWith('.lock')) return 'skipped';
  if (AGENT.has(name) || /^git-.*\.json$/.test(name)) return 'agent';
  if (FRONT.has(name) || name.startsWith('install-id-')) return 'front-door';
  return 'unclassified';
};

export async function shareSettingsProjects<Result>({ settings, sharing, say = () => {} }: {
  readonly settings: MigrationValue; readonly sharing: ProjectSharing<Result>; readonly say?: (message: string) => void;
}) {
  const results: (Result | RefusedProject)[] = [];
  const projects = isMigrationObject(settings) && Array.isArray(settings['projects']) ? settings['projects'] : [];
  for (const project of projects) {
    const directory = isString(project) ? project : isMigrationObject(project) ? project['path'] : undefined;
    if (!isString(directory)) continue;
    try { results.push(await sharing.share(directory)); }
    catch (error) {
      const code = isRecord(error) && isString(error['code']) ? error['code'] : undefined;
      const message = isRecord(error) && isString(error['message']) ? error['message'] : undefined;
      results.push({ path: directory, status: 'refused', code, message });
      say(`Project ${directory} was not shared: ${message}`);
    }
  }
  return results;
}

export async function migrateAccounts<Result = JsonValue>(options: MigrateAccountsOptions<Result>) {
  const { root = '/', system, accounts, envFile, dryRun = false, sharing, trustedBotWorktrees = [], say = () => {} } = options;
  const at = (file: string) => path.join(root, file);
  const { human, front, agent } = accounts;
  const oldData = oldDataDirectory(await readOptional(envFile), human);
  const source = at(oldData);
  const frontData = at(`${FRONT_HOME}/.config/openchamber`);
  const agentData = at(`${agent.home}/.config/openchamber`);
  const manifestFile = at(`${FRONT_HOME}/migration.json`);
  const previous = await readOptional(manifestFile);
  const manifest: MigrationManifest<Result> = previous ? JSON.parse(previous) : { version: 1, files: [], worktrees: [], projects: [], blockedProjects: [] };
  manifest.blockedProjects = [];
  const base = { root, system, source, botRoot: path.join(oldData, 'bot-worktrees'), frontData, agentData, owner: human, manifest, trustedBotWorktrees };
  const context: MigrationContext = options.dryRun
    ? { ...base, dryRun: true, front, agent }
    : { ...base, dryRun: false, front: options.accounts.front, agent: options.accounts.agent };
  const originalCount = manifest.files.length;
  for (const directory of [frontData, agentData, at(`${agent.home}/.local/share/opencode`), at(`${agent.home}/.config/opencode`)]) await requirePhysicalDirectory(root, directory);
  if (!dryRun) for (const unit of ['openchamber.service', 'openchamber-agent.service']) {
    if (!['inactive', 'failed', 'unknown'].includes(await system.isActive(unit))) fail('migration_runtime_running', `Stop ${unit} before migrating account data`);
  }
  if (!context.dryRun) {
    for (const [directory, account] of [[at(`${FRONT_HOME}/.config`), context.front], [frontData, context.front], [at(`${agent.home}/.config`), context.agent], [agentData, context.agent], [at(`${agent.home}/.local`), context.agent], [at(`${agent.home}/.local/share`), context.agent]] as const) {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await ownTree(system, directory, account);
    }
  }
  try {
    for (const name of await entries(source)) {
      const kind = classify(name);
      if (name === 'projects') { await splitProjects(context); continue; }
      if (name === 'bots') { await splitBotControl(context); continue; }
      if (name === 'bot-worktrees') { await retainBotWorktrees(context); continue; }
      if (name === 'message-queue.json') { await splitMessageQueue(context); continue; }
      if (kind === 'skipped') { manifest.files.push({ source: path.join(source, name), target: null, class: kind, status: 'skipped' }); continue; }
      if (name === FIX_LOOPS) { await splitFixLoops(context, path.join(source, name)); continue; }
      const target = path.join(kind === 'agent' ? agentData : frontData, name);
      await copyEntry(context, { source: path.join(source, name), target, account: kind === 'agent' ? 'agent' : 'front', kind,
        strict: name === 'bot-provider-events.json' || AGENT_BOT_RECORDS.has(name) });
      if (kind === 'unclassified') say(`Unclassified data retained by the front door: ${name}`);
    }
    if (manifest.blockedProjects.length) fail('migration_bots_blocked', 'Repair the blocked Bots projects before starting either runtime');
    const settingsText = await readOptional(path.join(frontData, 'settings.json')) ?? await readOwned(path.join(source, 'settings.json'), human);
    const settings: JsonValue = settingsText ? JSON.parse(settingsText) : {};
    const mirror = path.join(agentData, 'settings.json');
    const mirrorRecord: MigrationFile = { source: path.join(source, 'settings.json'), target: mirror, class: 'agent-settings', status: dryRun ? 'planned' : 'existing' };
    manifest.files.push(mirrorRecord);
    if (!context.dryRun) {
      try {
        await fs.writeFile(mirror, `${JSON.stringify(pickAgentSettings(settings), null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        await system.chown(mirror, context.agent.uid, context.agent.gid);
        mirrorRecord.status = 'copied';
      } catch (error) { if (!hasCode(error, 'EEXIST')) throw error; }
    }
    for (const [suffix, filter] of [['.local/share/opencode', (name: string) => !['worktree', 'log', 'bin'].includes(name)], ['.config/opencode', null]] as const) {
      const from = at(path.join(human.home, suffix));
      if (await fs.lstat(from).catch(() => null)) await copyEntry(context, { source: from, target: at(path.join(agent.home, suffix)), account: 'agent', kind: 'opencode', filter });
    }
    manifest.worktrees = (await entries(at(`${human.home}/.local/share/opencode/worktree`))).map((name) => `${human.home}/.local/share/opencode/worktree/${name}`);
    if (!dryRun && sharing) manifest.projects = await shareSettingsProjects({ settings, sharing, say });
    for (const directory of manifest.worktrees) say(`Existing OpenCode worktree left in place: ${directory}`);
    if (dryRun) say(JSON.stringify({ ...manifest, files: manifest.files.slice(originalCount) }, null, 2));
    return manifest;
  } finally {
    if (!dryRun) {
      await fs.writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      await fs.chmod(manifestFile, 0o600);
      await system.chown(manifestFile, 0, 0);
    }
  }
}
