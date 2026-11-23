import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isNumber, isPlainObject } from '../../shared/guards.js';
import { isConnectionId, ProtectedMcpError } from './contract.js';
import type { ConnectionId } from './contract.js';
import { parseDefinition } from './definitions.js';
import type { StoredDefinition } from './definition-types.js';
import type { JsonValue } from '../../shared/json-values.js';

export async function readDefinitions(stateDir: string): Promise<Map<ConnectionId, StoredDefinition>> {
  const definitions = new Map<ConnectionId, StoredDefinition>();
  const stored = await readJson(path.join(stateDir, 'state.json'));
  if (stored === null) return definitions;
  if (!isPlainObject(stored) || stored.version !== 1 || !Array.isArray(stored.connections)) throw new ProtectedMcpError('state_unreadable');
  for (const entry of stored.connections) {
    const value: JsonValue = entry;
    if (!isPlainObject(value) || !isConnectionId(value.id) || !isNumber(value.revision) || !Number.isSafeInteger(value.revision)) throw new ProtectedMcpError('state_unreadable');
    const { id, revision, ...definition } = value;
    definitions.set(id, { id, revision, ...parseDefinition(definition) });
  }
  return definitions;
}

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
}

export class StateDurabilityError extends ProtectedMcpError {
  constructor() {
    super('state_durability_unverified', { status: 500 });
    this.name = 'StateDurabilityError';
  }
}

export async function writePrivateFile(filename: string, content: string | Uint8Array, onCommit: () => void = () => {}): Promise<void> {
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${randomUUID()}.tmp`);
  let replaced = false;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, filename);
    replaced = true;
    onCommit();
    try {
      const directory = await fs.open(path.dirname(filename), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch {
      throw new StateDurabilityError();
    }
  } finally {
    if (!replaced) await fs.rm(temporary, { force: true });
  }
}

export async function readJson(filename: string): Promise<JsonValue> {
  try {
    return JSON.parse(await fs.readFile(filename, 'utf8'));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
};

export async function lockState(stateDir: string): Promise<() => Promise<void>> {
  const lockFile = path.join(stateDir, '.lock');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(lockFile, 'wx', 0o600);
      await handle.writeFile(String(process.pid));
      await handle.close();
      return () => fs.rm(lockFile, { force: true });
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
      const owner = Number(await fs.readFile(lockFile, 'utf8').catch(() => ''));
      if (Number.isSafeInteger(owner) && owner > 0 && processAlive(owner)) {
        throw new ProtectedMcpError('state_locked', { status: 500, message: `state_locked: process ${owner} owns ${stateDir}` });
      }
      await fs.rm(lockFile, { force: true });
    }
  }
  throw new ProtectedMcpError('state_locked', { status: 500 });
}
