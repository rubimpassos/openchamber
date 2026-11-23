import type { LocalMcpReaderPlatform, LocalMcpTarget } from '../opencode/mcp-local-reader.js';
import type { ConnectionId } from './service/contract.js';

type SelectionEntry = { readonly connection: ConnectionId; readonly disabled?: true };
type SelectionServers = Record<string, SelectionEntry>;
type SelectionTarget = { readonly global: string; readonly project: string; readonly identity: string };
type ReaderPlatform = Pick<LocalMcpReaderPlatform, 'fs' | 'path' | 'isBoolean' | 'isPlainObject' | 'isString'>;

// Serialized into the managed OpenCode plugin with the personal MCP reader.
// Every dependency is an argument, so bundling the host cannot rewrite imports.
export function protectedSelectionReader(dataDir: string, { fs, path, isBoolean, isPlainObject, isString }: ReaderPlatform) {
  class ProtectedSelectionError extends Error {
    readonly code: string;
    constructor(code: string) {
      super('Protected MCP selections could not be applied');
      this.name = 'ProtectedSelectionError';
      this.code = code;
    }
  }
  const fail: (code?: string) => never = (code = 'PROTECTED_SELECTION_INVALID') => { throw new ProtectedSelectionError(code); };
  const directory = path.join(dataDir, 'mcp-protected');
  const NAME = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;
  const CONNECTION = /^pmcp_[0-9a-f]{16}$/;
  // The serialized reader cannot capture the service parser's runtime import.
  const validConnection = (value: unknown): value is ConnectionId => isString(value) && CONNECTION.test(value);
  const validateName = (name: unknown) => {
    if (!isString(name) || name.length > 64 || !NAME.test(name)) fail();
  };
  const parseEntry = (value: unknown): SelectionEntry => {
    if (!isPlainObject(value)) fail();
    for (const key of Object.keys(value)) if (key !== 'connection' && key !== 'disabled') fail();
    if (!validConnection(value.connection)) fail();
    if ('disabled' in value && !isBoolean(value.disabled)) fail();
    return value.disabled === true ? { connection: value.connection, disabled: true } : { connection: value.connection };
  };
  const readDocument = (file: string, identity: string | null): { readonly servers: SelectionServers; readonly exists: boolean } => {
    let content;
    try { content = fs.readFileSync(file, 'utf8'); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { servers: {}, exists: false };
      fail('PROTECTED_SELECTION_UNREADABLE');
    }
    let document: unknown;
    try { document = JSON.parse(content); }
    catch { fail(); }
    if (!isPlainObject(document) || document.version !== 1 || !isPlainObject(document.servers)) fail();
    if (identity !== null && document.identity !== identity) fail();
    const servers: SelectionServers = {};
    for (const [name, entry] of Object.entries(document.servers)) {
      validateName(name);
      servers[name] = parseEntry(entry);
    }
    return { servers, exists: true };
  };
  /** The two files of a location, from the personal MCP reader's target for it. */
  const resolve = (localTarget: LocalMcpTarget) => ({
    directory,
    identity: localTarget.identity,
    global: path.join(directory, 'global.json'),
    project: path.join(directory, `project-${path.basename(localTarget.path)}`),
  });
  const readTarget = (target: SelectionTarget) => {
    const global = readDocument(target.global, null).servers;
    const project = readDocument(target.project, target.identity).servers;
    const effective: SelectionServers = {};
    for (const [name, entry] of Object.entries(global)) if (!entry.disabled) effective[name] = entry;
    for (const [name, entry] of Object.entries(project)) {
      if (entry.disabled) delete effective[name];
      else effective[name] = entry;
    }
    return { global, project, effective };
  };
  /** What OpenChamber installed for reaching the service, or null when it is absent or unreadable. */
  const readClientConfig = (file: string) => {
    let value: unknown;
    try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { return null; }
    if (!isPlainObject(value) || value.version !== 1 || !isString(value.socket) || !path.isAbsolute(value.socket)) return null;
    const relay = value.relay;
    if (!Array.isArray(relay) || relay.length === 0 || !relay.every((part: unknown): part is string => isString(part) && part.length > 0)) return null;
    return { socket: value.socket, relay: [...relay] };
  };
  const unavailable = ['/bin/sh', '-c', 'echo "OpenChamber protected MCP service is not installed or not readable on this host" >&2; exit 69'];
  /** OpenCode MCP entries for the effective selections: each starts the relay for one connection id. */
  const materialize = (effective: Readonly<SelectionServers>, clientConfigFile: string) => {
    const client = readClientConfig(clientConfigFile);
    const entries: Record<string, { readonly type: 'local'; readonly command: string[] }> = {};
    for (const [name, entry] of Object.entries(effective)) {
      entries[name] = {
        type: 'local',
        command: client ? [...client.relay, '--socket', client.socket, entry.connection] : [...unavailable],
      };
    }
    return entries;
  };
  return { resolve, readTarget, readDocument, materialize, validateName, parseEntry, readClientConfig };
}
