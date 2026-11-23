import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isPlainObject, isString } from '../../shared/guards.js';
import type { JsonObject, JsonValue } from '../../shared/json-values.js';
import { assertNever, isConnectionId, ProtectedMcpError } from './contract.js';
import type { ConnectionId, ConnectionName, CredentialState } from './contract.js';
import type { StoredDefinition } from './definition-types.js';
import type { StoreOperation } from './store-operation.js';
import type { Subject } from './subject-contract.js';
import { destinationFingerprint, secretSlots } from './definitions.js';
import { ensurePrivateDirectory, lockState, readDefinitions, readJson, writePrivateFile } from './state-files.js';
export { ensurePrivateDirectory, readDefinitions, writePrivateFile } from './state-files.js';
export { parseOperation } from './store-operation.js';
import { parseStoredSubjects, parseSubject, parseSubjectConnections, subjectViews } from './subject-contract.js';

const STATE_VERSION = 1;

type CredentialRecord = Readonly<JsonObject> & {
  readonly fingerprint: string; readonly secrets: Readonly<JsonObject>;
};
type StoreOptions = {
  readonly stateDir: string;
  readonly onChange?: (id: ConnectionId, change: { readonly restart: boolean }) => void;
  readonly onSubjectChange?: (subject: Subject, connections: readonly ConnectionId[]) => void;
};
type ApplyOptions = { readonly id?: ConnectionId };
type HandlerResult = {
  readonly definition: StoredDefinition | null; readonly restart: boolean;
  readonly removedCredentials?: { readonly definition: StoredDefinition; readonly credentials: CredentialRecord | null };
};
type OAuthUpdateOptions = {
  readonly restart?: boolean;
  readonly expect?: ((current: JsonValue | undefined, definition: StoredDefinition) => boolean) | null;
};
const isJsonObject = (value: JsonValue | undefined): value is JsonObject => isPlainObject(value);
const isCredentialRecord = (value: JsonValue): value is CredentialRecord =>
  isJsonObject(value) && isString(value.fingerprint) && isJsonObject(value.secrets);
const oauthTokens = (record: CredentialRecord | null) => isJsonObject(record?.oauth) ? record.oauth.tokens : undefined;

const notFound = () => new ProtectedMcpError('connection_not_found', { status: 404 });
const conflict = () => new ProtectedMcpError('revision_conflict', { status: 409 });

const requireSecrets = (slots: readonly string[], secrets: Readonly<Record<string, string>>, code: string) => {
  for (const slot of slots) {
    if (!isString(secrets[slot])) throw new ProtectedMcpError(code, { message: `${code}: ${slot}` });
  }
};

const refuseUnknownSecrets = (slots: readonly string[], secrets: Readonly<Record<string, string>>) => {
  for (const slot of Object.keys(secrets)) {
    if (!slots.includes(slot)) throw new ProtectedMcpError('unknown_secret', { message: `unknown_secret: ${slot}` });
  }
};

export async function openStore({ stateDir, onChange = () => {}, onSubjectChange = () => {} }: StoreOptions) {
  await ensurePrivateDirectory(stateDir);
  const unlock = await lockState(stateDir);
  const credentialsDir = path.join(stateDir, 'credentials');
  await ensurePrivateDirectory(credentialsDir);
  const stateFile = path.join(stateDir, 'state.json');
  const definitions = await readDefinitions(stateDir);
  let subjects: ReturnType<typeof parseStoredSubjects>;
  try {
    const state = await readJson(stateFile);
    subjects = parseStoredSubjects(isPlainObject(state) ? state.subjects : undefined, definitions);
  }
  catch (error) { await unlock(); throw error; }
  const credentials = new Map<ConnectionId, CredentialRecord>();
  for (const name of await fs.readdir(credentialsDir)) {
    const id = name.replace(/\.json$/, '');
    const file = path.join(credentialsDir, name);
    if (!name.endsWith('.json') || !isConnectionId(id) || !definitions.has(id)) {
      await fs.rm(file, { force: true });
      continue;
    }
    let record: JsonValue;
    try { record = JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
      throw error;
    }
    if (isCredentialRecord(record)) credentials.set(id, record);
  }

  const credentialFile = (id: ConnectionId) => path.join(credentialsDir, `${id}.json`);
  const persistDefinitions = (nextDefinitions = definitions, nextSubjects = subjects, onCommit?: () => void) => writePrivateFile(stateFile, `${JSON.stringify({
    version: STATE_VERSION,
    connections: [...nextDefinitions.values()],
    subjects: subjectViews(nextSubjects),
  }, null, 2)}\n`, onCommit);
  const persistCredentials = async (id: ConnectionId, record: CredentialRecord | null) => {
    if (record === null) {
      credentials.delete(id);
      await fs.rm(credentialFile(id), { force: true });
      return;
    }
    await writePrivateFile(credentialFile(id), `${JSON.stringify(record)}\n`);
    credentials.set(id, record);
  };

  const validCredentials = (definition: StoredDefinition) => {
    const record = credentials.get(definition.id);
    return record && record.fingerprint === destinationFingerprint(definition) ? record : null;
  };

  const credentialState = (definition: StoredDefinition): CredentialState => {
    const record = validCredentials(definition);
    if (definition.transport === 'http' && definition.http.oauth) {
      return oauthTokens(record) ? 'authorized' : 'authorization_required';
    }
    const slots = secretSlots(definition);
    if (slots.length === 0) return 'none';
    return record && slots.every((slot) => isString(record.secrets[slot])) ? 'stored' : 'missing';
  };

  const adminView = (definition: StoredDefinition) => {
    const record = validCredentials(definition);
    const secrets: Record<string, { readonly set: boolean }> = {};
    for (const slot of secretSlots(definition)) secrets[slot] = { set: Boolean(record && isString(record.secrets[slot])) };
    const { id: _id, revision: _revision, ...editable } = structuredClone(definition);
    const view = { ...structuredClone(definition), secrets, credential: credentialState(definition), editable };
    if (definition.transport === 'http' && definition.http.oauth) {
      const tokens = oauthTokens(record);
      return { ...view, oauth: { authorized: Boolean(tokens), expiresAt: isJsonObject(tokens) ? tokens.expiresAt ?? null : null, scope: isJsonObject(tokens) ? tokens.scope ?? null : null } };
    }
    return view;
  };

  const nameTaken = (name: ConnectionName, exceptId?: ConnectionId) => [...definitions.values()].some((definition) => definition.name === name && definition.id !== exceptId);
  const current = (id: ConnectionId, expectedRevision: number) => {
    const definition = definitions.get(id);
    if (!definition) throw notFound();
    if (definition.revision !== expectedRevision) throw conflict();
    return definition;
  };

  const handlers = {
    async create({ definition, secrets }: Extract<StoreOperation, { kind: 'create' }>, options: ApplyOptions = {}): Promise<HandlerResult> {
      const id = options.id ?? `pmcp_${randomBytes(8).toString('hex')}`;
      if (!isConnectionId(id)) throw new ProtectedMcpError('invalid_request', { message: 'id' });
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
    async update({ id, expectedRevision, definition, secrets }: Extract<StoreOperation, { kind: 'update' }>): Promise<HandlerResult> {
      const previous = current(id, expectedRevision);
      if (nameTaken(definition.name, id)) throw new ProtectedMcpError('name_taken', { status: 409 });
      const next = { id, revision: previous.revision + 1, ...definition };
      const slots = secretSlots(next);
      refuseUnknownSecrets(slots, secrets);
      const fingerprint = destinationFingerprint(next);
      const kept = validCredentials(previous);
      const moved = fingerprint !== destinationFingerprint(previous);
      if (moved) {
        requireSecrets(slots, secrets, 'credential_rebind_required');
        await persistCredentials(id, slots.length > 0 ? { version: 1, fingerprint, secrets, oauth: null } : null);
        await fs.rm(path.join(stateDir, 'connections', id), { recursive: true, force: true });
      } else {
        const merged: JsonObject = {};
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
    async 'set-enabled'({ id, expectedRevision, enabled }: Extract<StoreOperation, { kind: 'set-enabled' }>): Promise<HandlerResult> {
      const previous = current(id, expectedRevision);
      const next = { ...previous, revision: previous.revision + 1, enabled };
      definitions.set(id, next);
      await persistDefinitions();
      return { definition: next, restart: previous.enabled !== enabled };
    },
    async remove({ id, expectedRevision }: Extract<StoreOperation, { kind: 'remove' | 'revoke-credentials' }>): Promise<HandlerResult> {
      const previous = current(id, expectedRevision);
      const removedCredentials = { definition: previous, credentials: validCredentials(previous) };
      const next = new Map(definitions);
      next.delete(id);
      const nextSubjects = new Map([...subjects].map(([subject, connections]) => [subject, connections.filter((connection) => connection !== id)]));
      await persistDefinitions(next, nextSubjects, () => {
        definitions.delete(id);
        subjects = nextSubjects;
        onChange(id, { restart: true });
      });
      await persistCredentials(id, null);
      await fs.rm(path.join(stateDir, 'connections', id), { recursive: true, force: true });
      return { definition: null, restart: true, removedCredentials };
    },
    async 'revoke-credentials'({ id, expectedRevision }: Extract<StoreOperation, { kind: 'remove' | 'revoke-credentials' }>): Promise<HandlerResult> {
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
  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work);
    queue = run.then(() => undefined, () => undefined);
    return run;
  };

  return {
    close: async () => {
      await queue;
      await unlock();
    },
    list: () => [...definitions.values()].map((definition) => ({ definition, credential: credentialState(definition) })),
    get: (id: ConnectionId) => definitions.get(id),
    adminView: (id: ConnectionId) => {
      const definition = definitions.get(id);
      return definition ? adminView(definition) : null;
    },
    adminViews: () => [...definitions.values()].map(adminView),
    credentialState,
    credentialsFor: (definition: StoredDefinition) => validCredentials(definition),
    subjects: () => subjectViews(subjects),
    subjectAllows: (subject: Subject, id: ConnectionId) => subjects.get(subject)?.includes(id) === true,
    setSubject: (input: Subject, connections: readonly ConnectionId[]) => serialized(async () => {
      const subject = parseSubject(input);
      const allowed = parseSubjectConnections(connections);
      if (allowed.some((id) => !definitions.has(id))) throw new ProtectedMcpError('unknown_connection', { status: 404 });
      const next = new Map(subjects).set(subject, allowed);
      await persistDefinitions(definitions, next, () => {
        subjects = next;
        onSubjectChange(subject, allowed);
      });
      return { subject, connections: [...allowed] };
    }),
    removeSubject: (input: Subject) => serialized(async () => {
      const subject = parseSubject(input);
      const next = new Map(subjects);
      next.delete(subject);
      await persistDefinitions(definitions, next, () => {
        subjects = next;
        onSubjectChange(subject, []);
      });
    }),
    apply: (operation: StoreOperation, options?: ApplyOptions) => serialized(async () => {
      let result: HandlerResult;
      switch (operation.kind) {
        case 'create': result = await handlers.create(operation, options); break;
        case 'update': result = await handlers.update(operation); break;
        case 'set-enabled': result = await handlers['set-enabled'](operation); break;
        case 'remove': result = await handlers.remove(operation); break;
        case 'revoke-credentials': result = await handlers['revoke-credentials'](operation); break;
        default: return assertNever(operation);
      }
      const { definition, restart, removedCredentials = null } = result;
      if (definition) onChange(definition.id, { restart });
      return { connection: definition ? adminView(definition) : null, removedCredentials };
    }),
    updateOAuth: (id: ConnectionId, fingerprint: string, update: (current: JsonValue | undefined) => JsonValue | undefined, { restart = false, expect = null }: OAuthUpdateOptions = {}) => serialized(async () => {
      const definition = definitions.get(id);
      if (!definition || destinationFingerprint(definition) !== fingerprint) return false;
      const record = credentials.get(id);
      const base = record && record.fingerprint === fingerprint ? record : { version: 1, fingerprint, secrets: {}, oauth: null };
      if (expect && !expect(base.oauth, definition)) return false;
      await persistCredentials(id, { ...base, oauth: update(base.oauth) });
      onChange(id, { restart });
      return true;
    }),
    connectionDirectory: async (id: ConnectionId) => {
      const directory = path.join(stateDir, 'connections', id);
      await ensurePrivateDirectory(path.dirname(directory));
      await ensurePrivateDirectory(directory);
      return directory;
    },
  };
}
