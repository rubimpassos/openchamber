import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fail } from './host-inputs.js';
import { isPrimitiveString } from '../shared/guards.js';
import { projectConfigFileStemOf } from '../projects/project-id.js';
import { digestMutationInput } from '../source-control/mutation-executor.js';
import { readPlacement, readQueuedItem, readQueueSnapshot, readRuns } from './migration-records.js';
import { entries, isMigrationObject, missing, parseMigrationRecord, readItemSnapshot, readOptionalAuthority, readOwned, writeSplitJson } from './migration-copy.js';
import { blockProjectMigration } from './migration-projects.js';
import type { MigrationContext, MigrationValue, SplitDestination } from './migration-types.js';

type BotNotice = { readonly projectId: string; readonly itemId: string };

async function requireHostQueueOwner(context: MigrationContext, session: { readonly id: string; readonly directory: string; readonly notice: BotNotice }) {
  const { source, owner } = context;
  const { id: sessionId, directory, notice: { projectId, itemId } } = session;
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._:-]*$/.test(projectId) || ['.', '..'].includes(projectId)) fail('migration_bots_malformed', 'Invalid queued Bot project identity');
  const stem = projectConfigFileStemOf(projectId);
  const projectDirectory = path.join(source, 'projects', stem);
  const items = readItemSnapshot(parseMigrationRecord(await readOwned(path.join(projectDirectory, 'bots.json'), owner)));
  const item = items.find((entry) => entry.id === itemId);
  const stage = item && Object.entries(item.sessions ?? {}).find(([, id]) => id === sessionId)?.[0];
  if (!item || !stage || item.worktree !== directory || /^\/spaces(?:\/|$)/.test(directory)
    || items.filter((entry) => Object.values(entry.sessions ?? {}).includes(sessionId)).length !== 1) fail('migration_bots_conflict', 'Queued Bot session ownership does not match the retained item');
  const executionText = await readOptionalAuthority(path.join(projectDirectory, 'bot-executions', `${createHash('sha256').update(itemId).digest('hex')}.json`), owner);
  const execution = executionText === null ? null : parseMigrationRecord(executionText);
  if (executionText !== null && (!isMigrationObject(execution) || execution['version'] !== 1 || !isMigrationObject(execution['data'])
    || !isMigrationObject(execution['operations']))) fail('migration_bots_malformed', 'Invalid queued Bot execution history');
  const data = isMigrationObject(execution) && isMigrationObject(execution['data']) ? execution['data'] : null;
  const runs = readRuns(data?.['runs'] ?? {});
  for (const run of Object.values(runs)) if (run.projectId !== projectId || run.itemId !== itemId || run.bot.id !== item.botId
    || run.directory !== directory || run.bot.isolated) fail('migration_bots_conflict', 'Queued Bot execution placement conflicts with host delivery');
  const key = { projectId, itemId };
  const placementText = await readOptionalAuthority(path.join(source, 'bots/placements', `${digestMutationInput(key)}.json`), owner);
  const placement = placementText === null ? null : readPlacement(parseMigrationRecord(placementText));
  if (placement && (placement.projectId !== projectId || placement.itemId !== itemId || placement.botId !== item.botId
    || placement.hostDirectory !== directory || placement.isolated)
    || !placement && !Object.values(runs).some((run) => run.stage === stage)) fail('migration_bots_conflict', 'Queued Bot notice has no matching captured host placement');
  const binding = await readOptionalAuthority(path.join(source, 'bots/isolated-stages', `${digestMutationInput(key)}.json`), owner);
  if (binding !== null) fail('migration_bots_conflict', 'An isolated Bot notice cannot migrate into a host queue');
}

export async function splitMessageQueue(context: MigrationContext) {
  const { source, frontData, agentData, owner, dryRun } = context;
  const file = path.join(source, 'message-queue.json');
  const affected = new Set<string>();
  try {
    const stored = readQueueSnapshot(parseMigrationRecord(await readOwned(file, owner)));
    const ordinarySessions: (readonly [string, MigrationValue])[] = [];
    const destinations: SplitDestination[] = [];
    const ids = new Set<string>();
    for (const session of Object.values(stored.sessions)) for (const item of session.items) {
      const notice = isMigrationObject(item) ? item['notice'] : undefined;
      if (isMigrationObject(notice) && notice['kind'] === 'bot' && isPrimitiveString(notice['projectId']) && /^[A-Za-z0-9_-][A-Za-z0-9._:-]*$/.test(notice['projectId'])) {
        affected.add(projectConfigFileStemOf(notice['projectId']));
      }
    }
    for (const [sessionId, session] of Object.entries(stored.sessions)) {
      const ordinary: MigrationValue[] = [];
      const bots: MigrationValue[] = [];
      let botOwner: string | undefined;
      for (const raw of session.items) {
        const item = readQueuedItem(raw);
        if (item.id !== item.id.trim() || ids.has(item.id)) fail('migration_bots_malformed', 'Invalid or duplicate queued message');
        ids.add(item.id);
        if (item.origin?.kind !== 'bot') { ordinary.push(item); continue; }
        const notice = item['notice'];
        if (!isMigrationObject(notice) || !isPrimitiveString(notice['projectId']) || !isPrimitiveString(notice['itemId'])) fail('migration_bots_malformed', 'Invalid queued Bot notice identity');
        const identity = `${notice['projectId']}\0${notice['itemId']}`;
        if (botOwner && botOwner !== identity) fail('migration_bots_conflict', 'A queued Bot session has conflicting item owners');
        botOwner = identity;
        const marker = path.join(frontData, 'projects', `${projectConfigFileStemOf(notice['projectId'])}.json.bots-migration-blocked`);
        if (await fs.lstat(marker).catch(missing)) fail('migration_bots_blocked', 'Repair and explicitly clear the project migration blocker before retrying');
        await requireHostQueueOwner(context, { id: sessionId, directory: session.directory, notice: { projectId: notice['projectId'], itemId: notice['itemId'] } });
        bots.push(item);
      }
      if (ordinary.length || !session.items.length) ordinarySessions.push([sessionId, { ...session, items: ordinary }]);
      if (bots.length) destinations.push({ source: file, target: path.join(frontData, 'bots/host-queues', sessionId, 'message-queue.json'), account: 'front',
        kind: 'front-door', value: { ...stored, sessions: { [sessionId]: { ...session, items: bots } } } });
    }
    destinations.push({ source: file, target: path.join(agentData, 'message-queue.json'), account: 'agent', kind: 'agent', value: { ...stored, sessions: Object.fromEntries(ordinarySessions) } });
    for (const destination of destinations) await writeSplitJson(context, destination, true);
    if (!dryRun) for (const destination of destinations) await writeSplitJson(context, destination);
  } catch (error) {
    if (!affected.size) for (const stem of await entries(path.join(source, 'projects'))) {
      if (await fs.lstat(path.join(source, 'projects', stem, 'bots.json')).catch(() => null)) affected.add(stem);
    }
    if (!affected.size) throw error;
    for (const stem of affected) await blockProjectMigration(context, { file, stem, error });
  }
}
