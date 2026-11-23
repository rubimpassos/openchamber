import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fail, hasCode } from './host-inputs.js';
import { isRecord, isString } from '../shared/guards.js';
import { isBotScheduledRow, readBotWatchAuthority, validateOwnerBotsProject } from './migration-records.js';
import { copyEntry, entries, isMigrationObject, missing, parseMigrationRecord, readOwned, requirePhysicalDirectory, writeSplitJson } from './migration-copy.js';
import { readOptionalText as readOptional } from './host-files.js';
import type { MigrationContext, MigrationObject, MigrationValue, SplitDestination } from './migration-types.js';

export const FIX_LOOPS = 'pr-fix-loops.json';
const PROJECT_BOTS = new Set(['bots.json', 'bots-archive', 'bot-executions']);
type FixLoop = MigrationObject & { readonly id: MigrationValue; readonly sessionId: MigrationValue; readonly internal: MigrationObject | readonly MigrationValue[] };
const isFixLoop = (value: MigrationValue): value is FixLoop => isMigrationObject(value) && Boolean(value['id']) && Boolean(value['sessionId'])
  && (isMigrationObject(value['internal']) || Array.isArray(value['internal']));

export async function splitFixLoops(context: MigrationContext, file: string) {
  const { frontData, agentData, owner } = context;
  const stored = parseMigrationRecord(await readOwned(file, owner));
  if (!isMigrationObject(stored) || stored['version'] !== 1 && stored['version'] !== 2 || !Array.isArray(stored['loops'])
    || stored['workers'] !== undefined && !Array.isArray(stored['workers'])) fail('migration_bots_malformed', 'Invalid fix-loop migration state');
  const loops: readonly MigrationValue[] = stored['loops'];
  if (new Set(loops.map((loop) => isRecord(loop) ? loop['id'] : undefined)).size !== loops.length || !loops.every(isFixLoop)) fail('migration_bots_malformed', 'Invalid fix-loop migration state');
  const approval = (loop: FixLoop) => Boolean(loop['botAuthority'] || loop['worker'] || loop['pendingApproval'] || isRecord(loop['config']) && loop['config']['pushMode'] === 'approval');
  for (const loop of loops) if (loop['botAuthority']) {
    const authority = readBotWatchAuthority(loop['botAuthority']);
    const number = loop['number'];
    if (!isRecord(loop['config']) || loop['config']['pushMode'] !== 'auto' || !Number.isInteger(number) || Number(number) < 1
      || loop['owner'] !== authority.target.owner || loop['repo'] !== authority.target.repo
      || loop['branch'] !== (authority.publicationBranch ?? `bot/${authority.itemId}`)) fail('migration_bots_malformed', 'Invalid Bot PR watch migration authority');
  }
  const terminal = new Set(['ready', 'stopped', 'closed', 'limitReached', 'budgetReached', 'error']);
  const held = (loop: FixLoop) => !isString(loop['status']) || !terminal.has(loop['status']) || Boolean(loop['pendingApproval'] || isMigrationObject(loop.internal) && loop.internal['reviewJob']);
  for (const bot of loops.filter((loop) => loop['botAuthority'] && held(loop))) {
    if (loops.some((loop) => loop !== bot && held(loop) && isString(loop['owner']) && isString(bot['owner']) && loop['owner'].toLowerCase() === bot['owner'].toLowerCase()
      && isString(loop['repo']) && isString(bot['repo']) && loop['repo'].toLowerCase() === bot['repo'].toLowerCase() && loop['number'] === bot['number'])) {
      fail('migration_bots_conflict', 'A Bot watch and another fix loop hold the same pull request');
    }
  }
  for (const [kind, directory, account, value] of [
    ['front-door', frontData, 'front', { ...stored, loops: loops.filter(approval) }],
    ['agent', agentData, 'agent', { ...stored, loops: loops.filter((loop) => !approval(loop)), workers: [] }],
  ] as const) {
    await writeSplitJson(context, { source: file, target: path.join(directory, FIX_LOOPS), value, account, kind });
  }
}

export async function splitBotControl(context: MigrationContext) {
  const { source, frontData, agentData } = context;
  for (const name of await entries(path.join(source, 'bots'))) {
    if (name.endsWith('.lock') || name.endsWith('.lock.guard')) continue;
    const execution = name === 'proof';
    await copyEntry(context, { source: path.join(source, 'bots', name), target: path.join(execution ? agentData : frontData, 'bots', name),
      account: execution ? 'agent' : 'front', kind: execution ? 'agent' : 'front-door', strict: !execution });
  }
}

export async function splitProjects(context: MigrationContext) {
  const { source, frontData, agentData, owner, root } = context;
  const directory = path.join(source, 'projects');
  for (const name of await entries(directory)) {
    if (name.endsWith('.lock')) continue;
    const file = path.join(directory, name);
    const stem = name.endsWith('.json') ? name.slice(0, -5) : name;
    const marker = path.join(frontData, 'projects', `${stem}.json.bots-migration-blocked`);
    try {
      const blocked = await fs.lstat(marker).catch(missing);
      if (blocked) fail('migration_bots_blocked', 'Repair and explicitly clear the project migration blocker before retrying');
      const stats = await fs.stat(file);
      if (stats.uid !== owner.uid) fail('migration_bots_malformed', 'Unreadable project migration source');
      if (stats.isDirectory()) {
        for (const child of await entries(file)) {
          if (child.endsWith('.lock') || child.endsWith('.lock.guard')) continue;
          const bot = PROJECT_BOTS.has(child);
          await copyEntry(context, { source: path.join(file, child), target: path.join(bot ? frontData : agentData, 'projects', name, child),
            account: bot ? 'front' : 'agent', kind: bot ? 'front-door' : 'agent', strict: bot });
        }
        continue;
      }
      if (!name.endsWith('.json')) {
        await copyEntry(context, { source: file, target: path.join(agentData, 'projects', name), account: 'agent', kind: 'agent' });
        continue;
      }
      const text = await readOwned(file, owner);
      if (text === null) fail('migration_bots_malformed', 'Unreadable project migration source');
      const stored = validateOwnerBotsProject(parseMigrationRecord(text));
      const botRows = (stored.scheduledTasks ?? []).filter(isBotScheduledRow);
      const { bots, ...rest } = stored;
      const ordinary = { ...rest, scheduledTasks: (stored.scheduledTasks ?? []).filter((row) => !isBotScheduledRow(row)) };
      const owned = bots === undefined ? { version: 1, scheduledTasks: botRows } : { version: 1, scheduledTasks: botRows, bots };
      for (const [data, value] of [[frontData, owned], [agentData, ordinary]] as const) {
        const target = path.join(data, 'projects', name);
        await requirePhysicalDirectory(root, path.dirname(target));
        const targetStat = await fs.lstat(target).catch(missing);
        if (targetStat && !targetStat.isFile()) fail('migration_bots_conflict', `Conflicting project migration destination: ${target}`);
        const previous = targetStat ? await readOptional(target) : null;
        if (previous !== null && !isDeepStrictEqual(parseMigrationRecord(previous), value)) fail('migration_bots_conflict', `Conflicting project migration destination: ${target}`);
      }
      for (const [data, account, kind, value] of [[frontData, 'front', 'front-door', owned], [agentData, 'agent', 'agent', ordinary]] as const) {
        await writeSplitJson(context, { source: file, target: path.join(data, 'projects', name), value, account, kind } satisfies SplitDestination);
      }
    } catch (error) {
      await blockProjectMigration(context, { file, stem, error });
    }
  }
}

export async function blockProjectMigration(context: MigrationContext, { file, stem, error }: { readonly file: string; readonly stem: string; readonly error: unknown }) {
  const { frontData, system, manifest, root } = context;
  const marker = path.join(frontData, 'projects', `${stem}.json.bots-migration-blocked`);
  const code = isRecord(error) && isString(error['code']) ? error['code'] : 'migration_bots_malformed';
  if (!manifest.blockedProjects.some((entry) => entry.stem === stem)) manifest.blockedProjects.push({ stem, code });
  manifest.files.push({ source: file, target: marker, class: 'front-door', status: 'blocked', code });
  if (context.dryRun) return;
  await requirePhysicalDirectory(root, path.dirname(marker));
  await fs.mkdir(path.dirname(marker), { recursive: true, mode: 0o700 });
  await system.chown(path.dirname(marker), context.front.uid, context.front.gid);
  await fs.writeFile(marker, `${code}\n`, { flag: 'wx', mode: 0o600 })
    .catch((writeError) => { if (!hasCode(writeError, 'EEXIST')) throw writeError; });
  const stats = await fs.lstat(marker);
  if (!stats.isFile() || stats.nlink > 1) fail('migration_destination_link', 'The Bots migration blocker must be a private regular file');
  await system.chown(marker, context.front.uid, context.front.gid);
}
