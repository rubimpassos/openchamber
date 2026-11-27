import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createProjectConfigRuntime } from '../projects/project-config.js';
import { createBotsConfig, parseConfigEdit, readBotsConfig } from './config.js';

const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))); });
const setup = async () => {
  const directory = await fs.mkdtemp('/tmp/opencode/bots-config-');
  directories.push(directory);
  const runtime = createProjectConfigRuntime({ fsPromises: fs, path, projectsDirPath: directory });
  return { directory, runtime, config: createBotsConfig({ projectConfigRuntime: runtime, dataDir: directory }) };
};
const definition = () => ({ id: 'bugs', name: 'Bugs', mission: 'Fix verified bugs' });
const photo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jxioAAAAASUVORK5CYII=';

it.each([['photo', photo], ['removed photo', null], ['legacy definition', undefined]])('preserves the %s when the bot configuration is reopened', async (_label, avatar) => {
  const { config, runtime, directory } = await setup();
  await config.update('p', { definitions: [{ ...definition(), avatar }] });
  const reopened = createBotsConfig({ projectConfigRuntime: runtime, dataDir: directory });
  expect((await reopened.read('p')).definitions[0].avatar).toBe(avatar);
});

it.each([
  'https://example.com/photo.png',
  'data:image/svg+xml;base64,PHN2Zy8+',
  'data:image/jpeg;base64,aVBORw0KGgo=',
  `data:image/png;base64,${'A'.repeat(32768)}`,
])('rejects an invalid photo without replacing the saved bot', async (avatar) => {
  const { config } = await setup();
  await config.update('p', { definitions: [definition()] });
  await expect(config.update('p', { definitions: [{ ...definition(), name: 'Replacement', avatar }] })).rejects.toThrow();
  expect((await config.read('p')).definitions[0].name).toBe('Bugs');
});

it('defaults old projects and roundtrips all definition fields without accepting user approvals', async () => {
  const { config, runtime, directory } = await setup();
  expect(await config.read('p')).toEqual({ concurrency: 2, retentionDays: 90, definitions: [], approvals: {} });
  await runtime.updateSuggestedTasksSection('p', () => ({ enabled: true, future: 'preserved' }));
  const bot = {
    ...definition(), enabled: false, schedule: { kind: 'weekly', time: '10:30', weekdays: [1, 5], timezone: 'UTC' },
    source: { kind: 'jira', jql: 'project = QA', maxItems: 200 },
    models: { investigation: { useDefaults: false, providerID: 'p', modelID: 'm', variant: 'high', agent: 'plan' }, fixing: { useDefaults: true }, judge: { useDefaults: true } },
    mcp: [{ server: 'jira', tools: { search: 'allow', edit: 'ask' } }], correctionMcp: [{ server: 'jira', tools: { search: 'deny' } }], web: true,
    permissionMode: 'ask', goalTokenBudget: 100_000, notify: 'finish', isolated: true,
    identity: { github: { kind: 'app', identityId: 'gh-app' }, jira: { identityId: 'jira-user' }, discord: { identityId: 'discord-app' } },
    limits: { dailyTokens: 1_000_000, maxPendingHuman: 20 }, proof: { command: 'bun', args: ['test', '{files}'] }, jira: { doneTransition: '31' },
    discord: { channels: [{ guildId: '111111', channelId: '222222' }] },
  };
  const input = { concurrency: 4, retentionDays: 365, definitions: [bot], approvals: { forged: 'f'.repeat(64) } };
  await config.update('p', input);
  await config.setApproval('p', '.agents/areas/db.md', 'a'.repeat(64));
  await config.update('p', input);
  const restarted = createBotsConfig({ projectConfigRuntime: runtime, dataDir: directory });
  const edit = parseConfigEdit(input);
  expect(await restarted.read('p')).toEqual({ ...edit, definitions: edit.definitions.map((entry) => ({ ...entry, projects: { p: 'merge' } })),
    approvals: { '.agents/areas/db.md': 'a'.repeat(64) } });
  expect(await runtime.readSuggestedTasksSection('p')).toEqual({ enabled: true, future: 'preserved' });
  await config.setApproval('p', '.agents/areas/db.md', null);
  expect((await config.read('p')).approvals).toEqual({});
});

it('isolates approval and bots writes under the shared project lock', async () => {
  const { directory, config, runtime } = await setup();
  const second = createBotsConfig({ dataDir: directory, projectConfigRuntime: createProjectConfigRuntime({ fsPromises: fs, path, projectsDirPath: directory }) });
  await Promise.all([
    config.update('p', { definitions: [definition()] }),
    second.setApproval('p', '.openchamber/people.json', 'b'.repeat(64)),
    runtime.updateSuggestedTasksSection('p', () => ({ enabled: true })),
  ]);
  expect((await config.read('p')).definitions).toHaveLength(1);
  expect((await config.read('p')).approvals['.openchamber/people.json']).toBe('b'.repeat(64));
  expect(await runtime.readSuggestedTasksSection('p')).toEqual({ enabled: true });
});

it('rejects invalid config, duplicate ids and broken reads without replacing the file', async () => {
  const { runtime, config } = await setup();
  expect(readBotsConfig(null).ok).toBe(false);
  for (const raw of [{ concurrency: 0 }, { definitions: [definition(), definition()] }, { definitions: [{ ...definition(), models: { fixing: { useDefaults: false } } }] }]) {
    expect(() => parseConfigEdit(raw)).toThrow();
  }
  const file = runtime.resolveProjectConfigPath('p');
  for (const bytes of ['{', JSON.stringify({ version: 1, bots: { concurrency: -1 } })]) {
    await fs.writeFile(file, bytes);
    await expect(config.read('p')).rejects.toThrow();
    await expect(config.update('p', {})).rejects.toThrow();
    expect(await fs.readFile(file, 'utf8')).toBe(bytes);
  }
  await fs.rm(file);
  await fs.mkdir(file);
  await expect(config.read('p')).rejects.toThrow();
});

it('keeps defaults conservative while allowing all approved sources, identities and schedules', () => {
  const defaults = parseConfigEdit({ definitions: [definition()] }).definitions[0];
  expect(defaults).toMatchObject({ schedule: { kind: 'manual' }, web: false, isolated: false, notify: 'attention', permissionMode: 'default', limits: { dailyTokens: null, maxPendingHuman: null }, mcp: [], correctionMcp: [], discord: { channels: [] } });
  for (const kind of ['manual', 'daily', 'weekly', 'cron']) {
    expect(parseConfigEdit({ definitions: [{ ...definition(), schedule: { kind }, source: { kind: 'investigation', prompt: 'Find a bug', maxItems: 1000 }, identity: { github: { kind: 'account', accountId: 'account-1' } } }] }).definitions[0].schedule.kind).toBe(kind);
  }
});

it('rejects malformed and duplicate Discord channels without discarding persisted selections', async () => {
  const { config } = await setup();
  const discord = { channels: [{ guildId: '111111', channelId: '222222' }] };
  await config.update('p', { definitions: [{ ...definition(), discord }] });
  for (const channels of [[{ guildId: 'dm', channelId: '222222' }], [{ guildId: '111111', channelId: '0' }], [...discord.channels, ...discord.channels]]) {
    await expect(config.update('p', { definitions: [{ ...definition(), discord: { channels } }] })).rejects.toThrow();
  }
  expect((await config.read('p')).definitions[0].discord).toEqual(discord);
});

it('migrates a project\'s legacy bots into the global list with full access to that project', async () => {
  // Given a project file written before bots became global, and another project's access to the same bot.
  const { config, runtime } = await setup();
  await config.saveDefinitions([{ ...definition(), projects: { q: 'read' } }], 0);
  await runtime.updateBotsSection('p', () => ({ concurrency: 3, definitions: [definition()] }));

  // When the project is read.
  const read = await config.read('p');

  // Then the same bot gained full access here and left the project file.
  expect(read.definitions).toEqual([expect.objectContaining({ id: 'bugs', projects: { q: 'read', p: 'merge' } })]);
  expect(read).toMatchObject({ concurrency: 3, retentionDays: 90, approvals: {} });
  expect(await runtime.readBotsSection('p')).toEqual({ concurrency: 3, retentionDays: 90, approvals: {}, definitions: [] });
});

it('shows each project only the bots with access to it and refuses a stale global write', async () => {
  // Given one bot that reads project a and another with full access to b.
  const { config } = await setup();
  const saved = await config.saveDefinitions([{ ...definition(), projects: { a: 'read' } }, { ...definition(), id: 'perf', projects: { b: 'merge' } }], 0);

  // When each project is read and an older revision is written.
  const a = await config.read('a');
  const b = await config.read('b');
  const stale = config.saveDefinitions([], 0);

  // Then the views differ by access, and the newer list survives.
  expect(a.definitions.map((bot) => [bot.id, bot.projects.a])).toEqual([['bugs', 'read']]);
  expect(b.definitions.map((bot) => bot.id)).toEqual(['perf']);
  await expect(stale).rejects.toMatchObject({ code: 'BOT_DEFINITIONS_CHANGED' });
  expect((await config.readDefinitions([])).definitions).toEqual(saved.definitions);
});

it('edits one project\'s bots without touching their access to other projects', async () => {
  // Given a bot that only reads project a and has full access to b.
  const { config } = await setup();
  await config.saveDefinitions([{ ...definition(), projects: { a: 'read', b: 'merge' } }], 0);

  // When project a renames it, and project b's list drops it.
  await config.update('a', { definitions: [{ ...definition(), name: 'Renamed' }] });
  await config.update('b', { definitions: [] });

  // Then the rename is global, a keeps read access, and only b lost access.
  expect((await config.readDefinitions([])).definitions).toEqual([expect.objectContaining({ name: 'Renamed', projects: { a: 'read' } })]);
});

it('keeps a project\'s differing legacy bot in that project when another project already migrated the same ID', async () => {
  // Given two projects whose legacy files define different bots under one ID.
  const { config, runtime } = await setup();
  await runtime.updateBotsSection('a', () => ({ definitions: [{ ...definition(), mission: 'Fix project A bugs' }] }));
  await runtime.updateBotsSection('b', () => ({ definitions: [{ ...definition(), mission: 'Fix project B bugs' }] }));

  // When both are read, b twice.
  const a = await config.read('a');
  const b = await config.read('b');
  const { revision } = await config.readDefinitions([]);
  const again = await config.read('b');

  // Then each project keeps its own mission, b's copy stays local, and repeated reads write nothing.
  expect(a.definitions.map((bot) => bot.mission)).toEqual(['Fix project A bugs']);
  expect(b.definitions.map((bot) => [bot.mission, bot.projects])).toEqual([['Fix project B bugs', { b: 'merge' }]]);
  expect(again).toEqual(b);
  expect((await config.readDefinitions([])).revision).toBe(revision);
  expect((await config.readDefinitions([])).definitions.map((bot) => [bot.mission, bot.projects])).toEqual([['Fix project A bugs', { a: 'merge' }]]);
});
