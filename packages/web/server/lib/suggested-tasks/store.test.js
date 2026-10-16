import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createSuggestionStore } from './store.js';

const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const setup = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'suggested-store-'));
  directories.push(directory);
  const store = createSuggestionStore({ projectsDirPath: directory });
  return store;
};

it('distinguishes a missing inbox from malformed or future-version data, and preserves failed reads', async () => {
  const store = await setup();
  expect(await store.read('p1')).toEqual({ suggestions: [], runs: [], lastScanned: {} });
  const file = store.filePathFor('p1');
  await fs.mkdir(path.dirname(file), { recursive: true });
  for (const bytes of ['{', '{}', '{"version":2,"suggestions":[],"runs":[]}']) {
    await fs.writeFile(file, bytes);
    await expect(store.update('p1', () => ({ inbox: { suggestions: [], runs: [], lastScanned: {} } }))).rejects.toThrow();
    expect(await fs.readFile(file, 'utf8')).toBe(bytes);
  }
});

it('refuses project identifiers that could escape the projects directory', async () => {
  const store = await setup();
  for (const projectId of ['..', '../other', '/tmp/other', 'a/../../other']) {
    await expect(store.read(projectId)).rejects.toThrow();
  }
});

it('serializes simultaneous writers from independent store instances without losing either mutation', async () => {
  const store = await setup();
  const second = createSuggestionStore({ projectsDirPath: path.dirname(path.dirname(store.filePathFor('p1'))) });
  await Promise.all([
    store.update('p1', (inbox) => ({ inbox: { ...inbox, lastScanned: { ...inbox.lastScanned, main: 'a' } } })),
    second.update('p1', (inbox) => ({ inbox: { ...inbox, lastScanned: { ...inbox.lastScanned, release: 'b' } } })),
  ]);
  expect((await store.read('p1')).lastScanned).toEqual({ main: 'a', release: 'b' });
});
