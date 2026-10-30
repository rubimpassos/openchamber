import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isBoolean, isPlainObject, isString } from '../../shared/guards.js';
import { ProtectedMcpError, isConnectionId } from './contract.js';
import { destinationFingerprint, parseDefinition, secretSlots } from './definitions.js';

const STATE_VERSION = 1;
const MAX_SECRET_LENGTH = 64 * 1024;

export async function ensurePrivateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
}

/** Same-directory temporary file, flushed, then renamed over the target, mode 0600. */
export async function writePrivateFile(filename, content) {
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, filename);
    const directory = await fs.open(path.dirname(filename), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/** The parsed file, or null when it does not exist. */
const readJson = async (filename) => {
  try {
    return JSON.parse(await fs.readFile(filename, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};

const notFound = () => new ProtectedMcpError('connection_not_found', { status: 404 });
const conflict = () => new ProtectedMcpError('revision_conflict', { status: 409 });

const parseSecrets = (value) => {
  if (value === undefined) return {};
  if (!isPlainObject(value)) throw new ProtectedMcpError('invalid_request', { message: 'secrets' });
  const secrets = {};
  for (const [slot, secret] of Object.entries(value)) {
    if (!isString(secret) || secret.length === 0 || secret.length > MAX_SECRET_LENGTH) {
      throw new ProtectedMcpError('invalid_secret', { message: `invalid_secret: ${slot}` });
    }
    secrets[slot] = secret;
  }
  return secrets;
};

/** An administrative change as an `apply` frame carries it; the shape is checked here, the rules below. */
export function parseOperation(value) {
  if (!isPlainObject(value) || !isString(value.kind)) throw new ProtectedMcpError('invalid_request', { message: 'operation' });
  const existing = () => {
    if (!isConnectionId(value.id) || !Number.isSafeInteger(value.expectedRevision)) {
      throw new ProtectedMcpError('invalid_request', { message: 'id and expectedRevision' });
    }
    return { id: value.id, expectedRevision: value.expectedRevision };
  };
  switch (value.kind) {
    case 'create':
      return { kind: 'create', definition: parseDefinition(value.definition), secrets: parseSecrets(value.secrets) };
    case 'update':
      return { kind: 'update', ...existing(), definition: parseDefinition(value.definition), secrets: parseSecrets(value.secrets) };
    case 'set-enabled':
      if (!isBoolean(value.enabled)) throw new ProtectedMcpError('invalid_request', { message: 'enabled' });
      return { kind: 'set-enabled', ...existing(), enabled: value.enabled };
    case 'remove':
    case 'revoke-credentials':
      return { kind: value.kind, ...existing() };
    default:
      throw new ProtectedMcpError('invalid_request', { message: 'kind' });
  }
}

const requireSecrets = (slots, secrets, code) => {
  for (const slot of slots) {
    if (!isString(secrets[slot])) throw new ProtectedMcpError(code, { message: `${code}: ${slot}` });
  }
};

const refuseUnknownSecrets = (slots, secrets) => {
  for (const slot of Object.keys(secrets)) {
    if (!slots.includes(slot)) throw new ProtectedMcpError('unknown_secret', { message: `unknown_secret: ${slot}` });
  }
};

const processAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

/** One owner at a time: the running service, or the migration tool while the service is stopped. */
async function lockState(stateDir) {
  const lockFile = path.join(stateDir, '.lock');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(lockFile, 'wx', 0o600);
      await handle.writeFile(String(process.pid));
      await handle.close();
      return () => fs.rm(lockFile, { force: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = Number(await fs.readFile(lockFile, 'utf8').catch(() => ''));
      if (Number.isSafeInteger(owner) && owner > 0 && processAlive(owner)) {
        throw new ProtectedMcpError('state_locked', { status: 500, message: `state_locked: process ${owner} owns ${stateDir}` });
      }
      await fs.rm(lockFile, { force: true });
    }
  }
  throw new ProtectedMcpError('state_locked', { status: 500 });
}

/**
 * The stored definitions by id, read without taking the state: no lock, no
 * directory created, nothing tidied. Missing state reads as none.
 */
export async function readDefinitions(stateDir) {
  const definitions = new Map();
  const stored = await readJson(path.join(stateDir, 'state.json'));
  if (stored === null) return definitions;
  if (!isPlainObject(stored) || stored.version !== STATE_VERSION || !Array.isArray(stored.connections)) {
    throw new ProtectedMcpError('state_unreadable');
  }
  for (const entry of stored.connections) {
    if (!isPlainObject(entry) || !isConnectionId(entry.id) || !Number.isSafeInteger(entry.revision)) throw new ProtectedMcpError('state_unreadable');
    const { id, revision, ...definition } = entry;
    definitions.set(id, { id, revision, ...parseDefinition(definition) });
  }
  return definitions;
}

/**
 * The protected state: definitions in `state.json`, each connection's
 * credentials in `credentials/<id>.json` bound to its destination fingerprint,
 * worker state under `connections/<id>/`. One process owns it and changes are
 * applied one at a time.
 */
export async function openStore({ stateDir, onChange = () => {} }) {
  await ensurePrivateDirectory(stateDir);
  const unlock = await lockState(stateDir);
  const credentialsDir = path.join(stateDir, 'credentials');
  await ensurePrivateDirectory(credentialsDir);
  const stateFile = path.join(stateDir, 'state.json');
  const definitions = await readDefinitions(stateDir);
  const credentials = new Map();
  for (const name of await fs.readdir(credentialsDir)) {
    const id = name.replace(/\.json$/, '');
    const file = path.join(credentialsDir, name);
    if (!name.endsWith('.json') || !definitions.has(id)) {
      // Left by a removal interrupted after the definition went: never used again.
      await fs.rm(file, { force: true });
      continue;
    }
    const record = await readJson(file);
    if (isPlainObject(record) && isString(record.fingerprint) && isPlainObject(record.secrets)) credentials.set(id, record);
  }

  const credentialFile = (id) => path.join(credentialsDir, `${id}.json`);
  const persistDefinitions = () => writePrivateFile(stateFile, `${JSON.stringify({
    version: STATE_VERSION,
    connections: [...definitions.values()],
  }, null, 2)}\n`);
  const persistCredentials = async (id, record) => {
    if (record === null) {
      credentials.delete(id);
      await fs.rm(credentialFile(id), { force: true });
      return;
    }
    await writePrivateFile(credentialFile(id), `${JSON.stringify(record)}\n`);
    credentials.set(id, record);
  };

  /** Credentials for this exact destination, or null when they belong to another one. */
  const validCredentials = (definition) => {
    const record = credentials.get(definition.id);
    return record && record.fingerprint === destinationFingerprint(definition) ? record : null;
  };

  const credentialState = (definition) => {
    const record = validCredentials(definition);
    if (definition.transport === 'http' && definition.http.oauth) {
      return record?.oauth?.tokens ? 'authorized' : 'authorization_required';
    }
    const slots = secretSlots(definition);
    if (slots.length === 0) return 'none';
    return record && slots.every((slot) => isString(record.secrets[slot])) ? 'stored' : 'missing';
  };

  const adminView = (definition) => {
    const record = validCredentials(definition);
    const secrets = {};
    for (const slot of secretSlots(definition)) secrets[slot] = { set: Boolean(record && isString(record.secrets[slot])) };
    const view = { ...structuredClone(definition), secrets, credential: credentialState(definition) };
    // Exactly what an update accepts, so Settings edits this and nothing it was only shown.
    const { id: _id, revision: _revision, ...editable } = structuredClone(definition);
    view.editable = editable;
    if (definition.transport === 'http' && definition.http.oauth) {
      const tokens = record?.oauth?.tokens;
      view.oauth = { authorized: Boolean(tokens), expiresAt: tokens?.expiresAt ?? null, scope: tokens?.scope ?? null };
    }
    return view;
  };

  const nameTaken = (name, exceptId) => [...definitions.values()].some((definition) => definition.name === name && definition.id !== exceptId);
  const current = (id, expectedRevision) => {
    const definition = definitions.get(id);
    if (!definition) throw notFound();
    if (definition.revision !== expectedRevision) throw conflict();
    return definition;
  };

  // Each handler answers the connection after the change and whether its
  // running sessions must end: a new destination, new credentials or a new
  // enabled state cannot be swapped into a session the client initialized.
  const handlers = {
    async create({ definition, secrets }, { id = `pmcp_${randomBytes(8).toString('hex')}` } = {}) {
      if (nameTaken(definition.name)) throw new ProtectedMcpError('name_taken', { status: 409 });
      if (definitions.has(id)) throw new ProtectedMcpError('connection_exists', { status: 409 });
      const slots = secretSlots(definition);
      refuseUnknownSecrets(slots, secrets);
      requireSecrets(slots, secrets, 'secret_missing');
      const next = { id, revision: 1, ...definition };
      if (slots.length > 0) await persistCredentials(id, { version: 1, fingerprint: destinationFingerprint(next), secrets, oauth: null });
      definitions.set(id, next);
      await persistDefinitions();
      return { definition: next, restart: false };
    },
    async update({ id, expectedRevision, definition, secrets }) {
      const previous = current(id, expectedRevision);
      if (nameTaken(definition.name, id)) throw new ProtectedMcpError('name_taken', { status: 409 });
      const next = { id, revision: previous.revision + 1, ...definition };
      const slots = secretSlots(next);
      refuseUnknownSecrets(slots, secrets);
      const fingerprint = destinationFingerprint(next);
      const kept = validCredentials(previous);
      const moved = fingerprint !== destinationFingerprint(previous);
      if (moved) {
        // A new destination never inherits a credential: the administrator types it again for it.
        requireSecrets(slots, secrets, 'credential_rebind_required');
        await persistCredentials(id, slots.length > 0 ? { version: 1, fingerprint, secrets, oauth: null } : null);
        // Worker state holds token caches and grants, which belong to the old destination too.
        await fs.rm(path.join(stateDir, 'connections', id), { recursive: true, force: true });
      } else {
        const merged = {};
        for (const slot of slots) {
          const value = secrets[slot] ?? kept?.secrets[slot];
          if (value !== undefined) merged[slot] = value;
        }
        const oauth = kept?.oauth ?? null;
        await persistCredentials(id, slots.length > 0 || oauth ? { version: 1, fingerprint, secrets: merged, oauth } : null);
      }
      definitions.set(id, next);
      await persistDefinitions();
      return { definition: next, restart: moved || Object.keys(secrets).length > 0 || previous.enabled !== next.enabled };
    },
    async 'set-enabled'({ id, expectedRevision, enabled }) {
      const previous = current(id, expectedRevision);
      const next = { ...previous, revision: previous.revision + 1, enabled };
      definitions.set(id, next);
      await persistDefinitions();
      return { definition: next, restart: previous.enabled !== enabled };
    },
    async remove({ id, expectedRevision }) {
      const previous = current(id, expectedRevision);
      const removedCredentials = { definition: previous, credentials: validCredentials(previous) };
      definitions.delete(id);
      await persistDefinitions();
      await persistCredentials(id, null);
      await fs.rm(path.join(stateDir, 'connections', id), { recursive: true, force: true });
      return { definition: null, restart: true, removedCredentials };
    },
    async 'revoke-credentials'({ id, expectedRevision }) {
      const previous = current(id, expectedRevision);
      const removedCredentials = { definition: previous, credentials: validCredentials(previous) };
      await persistCredentials(id, null);
      const next = { ...previous, revision: previous.revision + 1 };
      definitions.set(id, next);
      await persistDefinitions();
      return { definition: next, restart: true, removedCredentials };
    },
  };

  let queue = Promise.resolve();
  const serialized = (work) => {
    const run = queue.then(work);
    queue = run.catch(() => {});
    return run;
  };

  return {
    /** Waits for queued changes, then releases the state for another owner. */
    close: async () => {
      await queue;
      await unlock();
    },
    list: () => [...definitions.values()].map((definition) => ({ definition, credential: credentialState(definition) })),
    get: (id) => definitions.get(id),
    adminView: (id) => {
      const definition = definitions.get(id);
      return definition ? adminView(definition) : null;
    },
    adminViews: () => [...definitions.values()].map(adminView),
    credentialState,
    /** For the service's own workers only. Never serialized into any answer. */
    credentialsFor: (definition) => validCredentials(definition),
    /** Private result includes removed credentials for revocation only. Never serialize it into an answer. */
    apply: (operation, options) => serialized(async () => {
      const { definition, restart, removedCredentials = null } = await handlers[operation.kind](operation, options);
      onChange(definition?.id ?? operation.id, { restart });
      return { connection: definition ? adminView(definition) : null, removedCredentials };
    }),
    /**
     * Replaces the OAuth part of a connection's credentials when its
     * destination still matches. A refresh keeps sessions; a new authorization
     * or a revocation ends them (`restart`). `expect(current, definition)` is
     * checked inside the queue, after every earlier change: a write that began
     * before a revocation or a new authorization is dropped, so it cannot bring
     * back tokens the administrator removed.
     */
    updateOAuth: (id, fingerprint, update, { restart = false, expect = null } = {}) => serialized(async () => {
      const definition = definitions.get(id);
      if (!definition || destinationFingerprint(definition) !== fingerprint) return false;
      const record = credentials.get(id);
      const base = record && record.fingerprint === fingerprint ? record : { version: 1, fingerprint, secrets: {}, oauth: null };
      if (expect && !expect(base.oauth, definition)) return false;
      await persistCredentials(id, { ...base, oauth: update(base.oauth) });
      onChange(id, { restart });
      return true;
    }),
    connectionDirectory: async (id) => {
      const directory = path.join(stateDir, 'connections', id);
      await ensurePrivateDirectory(path.dirname(directory));
      await ensurePrivateDirectory(directory);
      return directory;
    },
  };
}
