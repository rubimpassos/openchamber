import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { createBotDriver } from '../runtime.test-support.js';
import { createBotExecutionStore } from '../execution-store.js';
import { botInputDigest } from '../effects.js';

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

async function legacyFixingRun(failed = false) {
  const root = await fs.mkdtemp('/tmp/opencode/bot-legacy-runtime-');
  roots.push(root);
  const driver = await createBotDriver(root, { held: ['fixing'] });
  const item = await driver.admit();
  await driver.runtime.pump('project');
  const itemFile = driver.store.filePathFor('project');
  const file = path.join(path.dirname(itemFile), 'bot-executions', `${createHash('sha256').update(item.id).digest('hex')}.json`);
  const entry = JSON.parse(await fs.readFile(file, 'utf8'));
  const snapshot = JSON.parse(await fs.readFile(itemFile, 'utf8'));
  const current = snapshot.items.find((record) => record.id === item.id);
  delete entry.data.runs['fixing:0'].bot.discord;
  delete entry.data.runs['fixing:0'].afterIdleId;
  delete entry.data.runs['fixing:0'].context;
  delete entry.data.runs['fixing:0'].selection;
  delete entry.data.runs['fixing:0'].prompt;
  for (const [key, request] of Object.entries(entry.operations)) {
    if (request.stage !== 'fixing') continue;
    delete request.bot.discord;
    delete request.afterIdleId;
    delete request.context;
    delete request.selection;
    delete request.prompt;
    current.effects.find((effect) => effect.key === key).inputDigest = botInputDigest(request);
  }
  if (failed) {
    current.state = 'needs-you';
    current.wait = { reason: 'BOT_STAGE_FAILED', since: current.updatedAt, channel: 'ui', people: [] };
    entry.data.resumeState = 'fixing';
    const sessionId = current.sessions.fixing;
    const dispatchedAt = entry.data.runs['fixing:0'].dispatchedAt;
    driver.records.set(sessionId, [
      { id: `idle_${sessionId}`, type: 'idle', outcome: 'failed', time: { created: dispatchedAt + 2 } },
      { id: `reply_${sessionId}`, type: 'assistant', content: [], error: { message: 'Provider unavailable' }, time: { created: dispatchedAt + 1 } },
    ]);
    driver.held.delete('fixing');
  }
  await fs.writeFile(file, JSON.stringify(entry));
  await fs.writeFile(itemFile, JSON.stringify(snapshot));
  return { driver, item, entry, journal: createBotExecutionStore({ store: driver.store }) };
}

it('replays a captured stage receipt when the current definition has additional defaults', async () => {
  const { driver, item } = await legacyFixingRun();
  const sessions = driver.calls.sessions.length;
  const runtime = driver.restart();

  await runtime.pump('project');

  expect((await runtime.detail('project', item.id)).item.state).toBe('fixing');
  expect(driver.calls.sessions).toHaveLength(sessions);
  expect(driver.calls.effects).toEqual([]);
});

it('preserves the original captured run when an explicit resume allocates another round', async () => {
  const { driver, item, entry, journal } = await legacyFixingRun(true);
  const runtime = driver.restart();

  await runtime.resume('project', item.id);

  const recovered = await journal.read('project', item.id);
  expect((await runtime.detail('project', item.id)).item.state).toBe('merging');
  expect(recovered.data.runs['fixing:0']).toEqual(entry.data.runs['fixing:0']);
  expect(recovered.data.runs['fixing:1']).toBeDefined();
  for (const [key, request] of Object.entries(entry.operations)) expect(recovered.operations[key]).toEqual(request);
});

it('captures raw selected model fields and omits undefined fields through restart', async () => {
  const root = await fs.mkdtemp('/tmp/opencode/bot-raw-selection-');
  roots.push(root);
  const driver = await createBotDriver(root, { held: ['investigation'] });
  const selection = { useDefaults: false, providerID: 'chosen', modelID: 'raw-model', variant: undefined };
  driver.dependencies.stages.select = async () => selection;
  const item = await driver.admit();

  await driver.runtime.pump('project');
  await driver.restart().pump('project');

  const entry = await createBotExecutionStore({ store: driver.store }).read('project', item.id);
  expect(entry.data.runs['investigation:0'].selection).toEqual({ useDefaults: false, providerID: 'chosen', modelID: 'raw-model' });
  expect(entry.operations[`${item.id}:investigation:0:create`].selection).toEqual(entry.data.runs['investigation:0'].selection);
  expect(Object.hasOwn(entry.data.runs['investigation:0'].selection, 'variant')).toBe(false);
  expect(driver.calls.sessions).toHaveLength(1);
});

it('retains an omitted selection without inventing a model', async () => {
  const root = await fs.mkdtemp('/tmp/opencode/bot-absent-selection-');
  roots.push(root);
  const driver = await createBotDriver(root, { held: ['investigation'] });
  driver.dependencies.stages.select = async () => undefined;
  const item = await driver.admit();

  await driver.runtime.pump('project');

  const entry = await createBotExecutionStore({ store: driver.store }).read('project', item.id);
  expect(Object.hasOwn(entry.data.runs['investigation:0'], 'selection')).toBe(false);
  expect(Object.hasOwn(entry.operations[`${item.id}:investigation:0:create`], 'selection')).toBe(false);
  expect((await driver.runtime.detail('project', item.id)).item.state).toBe('needs-you');
});
