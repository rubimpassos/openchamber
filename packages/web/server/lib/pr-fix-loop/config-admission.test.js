import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createFixLoopRuntime } from './runtime.js';

const input = { sessionId: 'ses_host', directory: '/repo', owner: 'qa', repo: 'qa', number: 1, branch: 'fix', config: { pushMode: 'auto' } };
const malformed = [['string', 'approval'], ['null', null], ['array', []], ['boolean', true]];
let dataDir;
let runtime;
beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fix-loop-config-'));
  runtime = createFixLoopRuntime({ dataDir, setTimer: () => null, clearTimer() {}, log: { warn() {} } });
});
afterEach(async () => {
  await runtime.stop();
  await fs.rm(dataDir, { recursive: true, force: true });
});

test.each(malformed)('refuses saved %s configuration before host dispatch', async (_kind, config) => {
  // Given a saved loop whose execution configuration cannot be interpreted.
  const file = path.join(dataDir, 'pr-fix-loops.json');
  const record = { ...input, id: 'fixloop_malformed', status: 'working', config, internal: { seen: [] } };
  const original = JSON.stringify({ version: 1, loops: [record] });
  await fs.writeFile(file, original);
  // When / Then: malformed configuration must not become auto authority or rewrite the file.
  await expect(runtime.assertHostDispatch(input.sessionId, input.directory, { kind: 'pr-fix-loop', id: record.id })).rejects.toThrow();
  expect(await fs.readFile(file, 'utf8')).toBe(original);
});

test.each(malformed)('refuses %s configuration on activation', async (_kind, config) => {
  // Given / When / Then: an uninterpretable request must not create a default auto loop.
  await expect(runtime.create({ ...input, config })).rejects.toThrow();
  expect(await runtime.list()).toEqual([]);
});

test.each(malformed)('refuses %s configuration updates without changing the loop', async (_kind, config) => {
  // Given an existing valid auto loop.
  const loop = await runtime.create(input);
  const file = path.join(dataDir, 'pr-fix-loops.json');
  const original = await fs.readFile(file, 'utf8');
  // When / Then: malformed configuration cannot replace its execution choice.
  await expect(runtime.update(loop.id, config)).rejects.toThrow();
  expect(await fs.readFile(file, 'utf8')).toBe(original);
});
