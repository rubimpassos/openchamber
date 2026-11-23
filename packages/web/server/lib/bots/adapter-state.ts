import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withSourceControlFileLock } from '../source-control/file-lock.js';
import { digestMutationInput } from '../source-control/mutation-executor.js';
import { hasSourceControlErrorCode } from '../source-control/input-guards.js';

type AdapterStateOptions<Value> = {
  readonly dataDir: string;
  readonly name: string;
  readonly schema: { parse(value: unknown): Value };
};

/** Private adapter records. File locks protect commits; owner locks protect effects. */
export function createBotAdapterState<Value>({ dataDir, name, schema }: AdapterStateOptions<Value>) {
  const directory = path.join(dataDir, 'bots', name);
  const fileFor = (key: unknown) => path.join(directory, `${digestMutationInput(key)}.json`);
  const load = async (file: string): Promise<Value | null> => {
    try { return schema.parse(JSON.parse(await fs.readFile(file, 'utf8'))); }
    catch (error) { if (hasSourceControlErrorCode(error) && error.code === 'ENOENT') return null; throw error; }
  };
  const read = (key: unknown) => withSourceControlFileLock(`${fileFor(key)}.lock`, () => load(fileFor(key)));
  const write = (key: unknown, value: unknown) => withSourceControlFileLock(`${fileFor(key)}.lock`, async () => {
    const parsed = schema.parse(value);
    const file = fileFor(key);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(parsed), { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
    return parsed;
  });
  const list = async () => {
    let names;
    try { names = await fs.readdir(directory); }
    catch (error) { if (hasSourceControlErrorCode(error) && error.code === 'ENOENT') return []; throw error; }
    const entries: Value[] = [];
    for (const name of names.filter((entry) => /^[a-f0-9]{64}\.json$/.test(entry))) {
      const file = path.join(directory, name);
      const entry = await withSourceControlFileLock(`${file}.lock`, () => load(file));
      if (entry) entries.push(entry);
    }
    return entries;
  };
  return { read, write, list, own: <Result>(key: unknown, operation: () => Result | Promise<Result>) => withSourceControlFileLock(`${fileFor(key)}.owner.lock`, operation, { waitMs: 10_000 }) };
}
