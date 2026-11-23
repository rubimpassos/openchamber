import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPlainObject, isString } from '../../shared/guards.js';
import type { JsonObject, JsonValue } from '../../shared/json-values.js';
import { ProtectedMcpError, isConnectionId } from './contract.js';
import type { ConnectionId } from './contract.js';
import { destinationFingerprint } from './definitions.js';
import { fail, parseManifest } from './migrate-manifest.js';
import type { CredentialSource, ManifestConnection, MigrationManifest } from './migrate-manifest.js';
import { ensurePrivateDirectory, openStore, readDefinitions, writePrivateFile } from './store.js';
export { parseManifest } from './migrate-manifest.js';

const ENV_LINE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
type MigrationOptions = {
  readonly stateDir: string; readonly manifest: MigrationManifest; readonly dryRun?: boolean;
  readonly readCredentialValue?: (from: CredentialSource) => JsonValue | undefined | Promise<JsonValue | undefined>;
  readonly readStateFile?: (file: string) => Promise<string | Uint8Array>;
};
type Owner = { readonly uid: number; readonly gid: number };
type CliOptions = { readonly getuid?: () => number; readonly restore?: (stateDir: string, owner: Owner) => Promise<void> };
type Journal = JsonObject & { readonly created: JsonObject[] };
type ReportLine = {
  readonly id: ConnectionId; readonly source: JsonValue; readonly name: string; readonly credentials: readonly string[];
  readonly fingerprints: Readonly<Record<string, string>>; readonly stateFiles: readonly string[];
  action: 'would-resume' | 'resumed' | 'present' | 'would-create' | 'created';
};

const isJournal = (value: unknown): value is Journal => isPlainObject(value) && Array.isArray(value.created)
  && value.created.every((entry: unknown): entry is JsonObject => isPlainObject(entry));
async function readJournal(file: string): Promise<Journal> {
  const value: unknown = JSON.parse(await fs.readFile(file, 'utf8').catch(() => '{"version":1,"created":[]}'));
  if (!isJournal(value)) throw new TypeError('Invalid migration journal');
  return value;
}

export function readEnvironmentValue(text: string, key: string): JsonValue {
  for (const line of text.split('\n')) {
    const match = ENV_LINE.exec(line.trim());
    if (!match || match[1] !== key) continue;
    const raw = match[2] ?? '';
    if (raw.startsWith('"')) {
      try {
        return JSON.parse(raw);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        fail('credential_unreadable', `${key} is not a quoted value`);
      }
    }
    return raw.startsWith("'") && raw.endsWith("'") ? raw.slice(1, -1) : raw;
  }
  return null;
}

const readCredential = async (from: CredentialSource): Promise<JsonValue> => {
  if ('file' in from) return (await fs.readFile(from.file, 'utf8')).replace(/\r?\n$/, '');
  return readEnvironmentValue(await fs.readFile(from.envFile, 'utf8'), from.key);
};

const fingerprintOf = (credential: string) => createHash('sha256').update(credential).digest('hex').slice(0, 12);

export async function migrate({ stateDir, manifest, dryRun = false, readCredentialValue = readCredential, readStateFile = (file) => fs.readFile(file) }: MigrationOptions) {
  const journalDir = path.join(stateDir, 'migrations');
  if (!dryRun) {
    await ensurePrivateDirectory(stateDir);
    await ensurePrivateDirectory(journalDir);
  }
  const journalFile = path.join(journalDir, 'journal.json');
  const journal = await readJournal(journalFile);
  const report: ReportLine[] = [];
  const prepared: { readonly connection: ManifestConnection; readonly secrets: Readonly<Record<string, string>> }[] = [];
  for (const connection of manifest.connections) {
    for (const file of connection.stateFiles) {
      await fs.access(file.from).catch(() => fail('state_file_missing', `${connection.source}: ${file.from} is missing`));
    }
    const slots: Record<string, string> = {};
    for (const [slot, from] of Object.entries(connection.credentials)) {
      let value;
      try {
        value = await readCredentialValue(from);
      } catch (error) {
        if (error instanceof ProtectedMcpError) throw error;
        const code = isPlainObject(error) || error instanceof Error ? ('code' in error ? error.code : null) : null;
        fail('credential_unreadable', `${connection.source}: credential ${slot} could not be read (${code ?? 'error'})`);
      }
      if (!isString(value) || value.length === 0) fail('credential_missing', `${connection.source}: credential ${slot} is empty or absent`);
      slots[slot] = value;
    }
    prepared.push({ connection, secrets: slots });
  }
  const store = dryRun ? null : await openStore({ stateDir });
  const stored = store ?? await readDefinitions(stateDir);
  const saveJournal = () => writePrivateFile(journalFile, `${JSON.stringify(journal, null, 2)}\n`);
  const copyStateFiles = async (connection: ManifestConnection, destination: Awaited<ReturnType<typeof openStore>>) => {
    const directory = await destination.connectionDirectory(connection.id);
    for (const file of connection.stateFiles) {
      const target = path.join(directory, file.to);
      await ensurePrivateDirectory(path.dirname(target));
      await writePrivateFile(target, await readStateFile(file.from));
    }
  };
  try {
    for (const { connection, secrets } of prepared) {
      const existing = stored.get(connection.id);
      const entry = journal.created.find((item) => item.id === connection.id) ?? null;
      const line: ReportLine = { id: connection.id, source: connection.source, name: connection.definition.name, credentials: Object.keys(secrets).sort(), action: dryRun ? 'would-create' : 'created',
        fingerprints: Object.fromEntries(Object.entries(secrets).map(([slot, value]) => [slot, fingerprintOf(value)])), stateFiles: connection.stateFiles.map((file) => file.to) };
      if (existing) {
        const same = destinationFingerprint(existing) === destinationFingerprint(connection.definition)
          && JSON.stringify(existing.policy) === JSON.stringify(connection.definition.policy);
        if (!same) fail('conflicting_connection', `${connection.id} exists with another destination or policy`);
        if (entry && entry.state !== 'done') {
          line.action = dryRun ? 'would-resume' : 'resumed';
          if (store) {
            await copyStateFiles(connection, store);
            entry.state = 'done';
            await saveJournal();
          }
        } else {
          line.action = 'present';
        }
        report.push(line);
        continue;
      }
      if (store) {
        const record = entry ?? { id: connection.id, state: 'pending' };
        if (!entry) journal.created.push(record);
        record.state = 'pending';
        await saveJournal();
        await store.apply({ kind: 'create', definition: connection.definition, secrets }, { id: connection.id });
        record.state = 'created';
        await saveJournal();
        await copyStateFiles(connection, store);
        record.state = 'done';
        await saveJournal();
      }
      report.push(line);
    }
  } finally {
    await store?.close();
  }
  return { report, selections: manifest.selections };
}

export async function rollbackMigration({ stateDir }: { readonly stateDir: string }) {
  const journalFile = path.join(stateDir, 'migrations', 'journal.json');
  const journal = await readJournal(journalFile);
  const store = await openStore({ stateDir });
  const removed: (JsonValue | undefined)[] = [];
  try {
    for (const entry of [...journal.created].reverse()) {
      const definition = isConnectionId(entry.id) ? store.get(entry.id) : null;
      if (definition) await store.apply({ kind: 'remove', id: definition.id, expectedRevision: definition.revision });
      removed.push(entry.id);
    }
  } finally {
    await store.close();
  }
  await writePrivateFile(journalFile, `${JSON.stringify({ version: 1, created: [] }, null, 2)}\n`);
  return { removed };
}

export function compareTools({ expected, actual }: { readonly expected: readonly string[]; readonly actual: readonly string[] }) {
  const want = new Set(expected);
  const have = new Set(actual);
  return {
    missing: [...want].filter((name) => !have.has(name)).sort(),
    added: [...have].filter((name) => !want.has(name)).sort(),
  };
}

const USAGE = `Usage: migrate.js <command> --state <dir> [--manifest <file>] [--dry-run]   (as root, service stopped)

Commands:
  apply      Create the manifest's connections with credentials read from the
             files it names. --dry-run checks everything and writes nothing.
  rollback   Remove the connections the last apply created.

The report lists each connection, the credential slots it filled and a short
fingerprint of each value to compare with the source, never the value.
The selections in the manifest are printed for OpenChamber; apply them with
PUT /api/protected-mcp/selections/<name> or in Settings.
`;

async function restoreOwner(stateDir: string, { uid, gid }: Owner) {
  for (const entry of await fs.readdir(stateDir, { recursive: true })) await fs.lchown(path.join(stateDir, entry), uid, gid);
  await fs.lchown(stateDir, uid, gid);
}

export async function cli(argv: readonly string[], { getuid = () => {
  if (!process.getuid) throw new TypeError('process.getuid is not a function');
  return process.getuid();
}, restore = restoreOwner }: CliOptions = {}) {
  const [command, ...rest] = argv;
  const dryRun = rest.includes('--dry-run');
  const option = (name: string) => {
    const index = rest.indexOf(name);
    return index === -1 ? null : rest[index + 1] ?? null;
  };
  if (!command || command === '--help' || rest.includes('--help')) {
    process.stdout.write(USAGE);
    return 0;
  }
  const stateDir = option('--state') ?? '/var/lib/openchamber-protected-mcp';
  const owner = await fs.stat(stateDir).then((stats) => ({ uid: stats.uid, gid: stats.gid }), () => null);
  if (!owner) fail('state_missing', `${stateDir} does not exist; install the service first`);
  try {
    if (command === 'apply') {
      const manifest = parseManifest(JSON.parse(await fs.readFile(option('--manifest') ?? '', 'utf8')));
      const result = await migrate({ stateDir, manifest, dryRun });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
    if (command === 'rollback') {
      process.stdout.write(`${JSON.stringify(await rollbackMigration({ stateDir }), null, 2)}\n`);
      return 0;
    }
  } finally {
    if (getuid() === 0 && !(command === 'apply' && dryRun)) await restore(stateDir, owner);
  }
  process.stderr.write(USAGE);
  return 64;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === await fs.realpath(process.argv[1])) {
  cli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }, (error: Error & { readonly code?: string }) => {
    process.stderr.write(`${error.code ?? 'error'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
