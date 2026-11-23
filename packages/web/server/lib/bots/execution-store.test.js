import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createBotExecutionStore } from './execution-store.js';

const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});
const setup = async () => {
  const directory = await fs.mkdtemp('/tmp/opencode/bots-execution-store-');
  directories.push(directory);
  const store = { filePathFor: (projectId) => path.join(directory, projectId, 'bots.json') };
  return { directory, store, journal: createBotExecutionStore({ store }) };
};

it('retains immutable requests and private recovery data across restart when updated', async () => {
  // Given a missing journal and a request captured before dispatch.
  const { directory, store, journal } = await setup();
  expect(await journal.read('p', '../item')).toEqual({ version: 1, operations: {}, data: {} });
  const request = { operation: 'pr.open', identityId: 'chosen', identityRevision: 1 };
  await journal.update('p', '../item', (entry) => ({ ...entry, operations: { publish: request } }));
  // When recovery data is written through a restarted owner.
  const restarted = createBotExecutionStore({ store });
  await restarted.update('p', '../item', (entry) => ({ ...entry, data: { placement: { kind: 'host', sessionId: 'ses_a' } } }));
  // Then the captured request is unchanged and the journal remains private and item-scoped.
  expect(await journal.read('p', '../item')).toEqual({ version: 1, operations: { publish: request },
    data: { placement: { kind: 'host', sessionId: 'ses_a' } } });
  const files = await fs.readdir(path.join(directory, 'p', 'bot-executions'));
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(/^[a-f0-9]{64}\.json$/);
  expect((await fs.stat(path.join(directory, 'p', 'bot-executions', files[0]))).mode & 0o777).toBe(0o600);
});

it.each(['replace', 'remove', 'invalid-json'])('preserves recorded authority when a change attempts to %s', async (attempt) => {
  // Given an existing operation whose authority is captured durably.
  const { journal } = await setup();
  const original = await journal.update('p', 'item', (entry) => ({ ...entry, operations: { publish: { identityRevision: 1 } } }));
  // When a writer changes or removes it, or supplies non-JSON recovery data.
  const change = (entry) => {
    if (attempt === 'replace') return { ...entry, operations: { publish: { identityRevision: 2 } } };
    if (attempt === 'remove') return { ...entry, operations: {} };
    return { ...entry, data: { invalid: undefined } };
  };
  await expect(journal.update('p', 'item', change)).rejects.toThrow();
  // Then the old journal remains authoritative.
  expect(await journal.read('p', 'item')).toEqual(original);
});

it('fails closed when persisted journal bytes are corrupt', async () => {
  // Given a journal that has become unreadable as JSON.
  const { directory, journal } = await setup();
  await journal.update('p', 'item', (entry) => entry);
  const folder = path.join(directory, 'p', 'bot-executions');
  const [name] = await fs.readdir(folder);
  const file = path.join(folder, name);
  await fs.writeFile(file, '{broken');
  // When recovery tries to replace it.
  await expect(journal.update('p', 'item', (entry) => entry)).rejects.toThrow();
  // Then a parse failure never becomes an authoritative empty journal.
  expect(await fs.readFile(file, 'utf8')).toBe('{broken');
});
