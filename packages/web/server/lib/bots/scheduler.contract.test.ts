import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createOwnerBotConfig } from './owner-config.js';
import { createBotScheduler } from './scheduler.js';
import { createScheduledTasksRuntime, type ScheduledTasksDependencies } from '../scheduled-tasks/runtime.js';

it('composes the owner store with bot scheduling when no project execution exists', async () => {
  // Given an owner-local store with no checkout or OpenCode dependencies.
  const root = await fs.mkdtemp('/tmp/opencode/owner-scheduler-contract-');
  const store = createOwnerBotConfig({ projectsDirPath: path.join(root, 'projects') });
  const calls: string[] = [];
  const dependencies = {
    mode: 'bots-only', projectConfigRuntime: store,
    listProjects: async () => [{ id: 'p', path: '/unavailable-project' }],
    runBot: async (_project: string, botId: string) => { calls.push(botId); return { items: [], skipped: false }; },
    logger: { info() {}, warn() {} },
  } satisfies ScheduledTasksDependencies;
  const runtime = createScheduledTasksRuntime(dependencies);
  const scheduler = createBotScheduler({ projectConfigRuntime: store, scheduledTasksRuntime: runtime });
  try {
    // When a disabled managed task is synced and run manually.
    await scheduler.sync('p', [{ id: 'bot-b', botId: 'b', botManaged: true, name: 'Bot', enabled: false,
      schedule: { kind: 'daily', times: ['09:00'] },
      execution: { prompt: 'Run', useDefaults: true, notify: 'attention' } }]);
    const result = await runtime.runNow('p', 'bot-b');

    // Then dispatch uses only the bot hook and persists its outcome.
    expect(result).toMatchObject({ ok: true, status: 'sent', task: { state: { lastStatus: 'sent' } } });
    expect(calls).toEqual(['b']);
  } finally {
    runtime.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});
