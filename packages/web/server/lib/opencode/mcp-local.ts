import path from 'node:path';
import { withSourceControlFileLock } from '../source-control/file-lock.js';
import { createLocalMcpReader } from './mcp-local-reader.js';
import { ensureLocalMcpDirectory, writeLocalMcpFile } from './mcp-local-files.js';
import type { McpEntity } from './config-v2.js';
import type { LocalMcpServer, LocalMcpSnapshot } from './mcp-local-reader.js';

export type { LocalMcpSnapshot } from './mcp-local-reader.js';
export interface LocalMcpStore {
  read(directory: string): LocalMcpSnapshot;
  create(name: string, config: McpEntity | Readonly<Record<string, unknown>>, directory: string): Promise<{ path: string }>;
  update(name: string, updates: Partial<McpEntity> | Readonly<Record<string, unknown>>, directory: string): Promise<{ path: string }>;
  remove(name: string, directory: string): Promise<{ path: string }>;
}

export function createLocalMcpStore({ dataDir }: { readonly dataDir: string }): LocalMcpStore {
  const reader = createLocalMcpReader(dataDir);
  const mutate = async (directory: string, operation: (servers: Record<string, LocalMcpServer>) => void) => {
    const target = reader.resolve(directory);
    await ensureLocalMcpDirectory(path.dirname(target.path));
    return withSourceControlFileLock(`${target.path}.lock`, async () => {
      const { servers } = reader.readTarget(target);
      operation(servers);
      await writeLocalMcpFile(target.path, `${JSON.stringify({ version: 1, identity: target.identity, servers }, null, 2)}\n`);
      return { path: target.path };
    });
  };
  const entityData = (config: object) => {
    // The shared editor sends null to remove an optional OpenCode override.
    return Object.fromEntries(Object.entries(config).filter(([key, value]) => key !== 'name' && key !== 'scope' && value !== null));
  };
  const missing = () => { throw Object.assign(new Error('Project-local MCP server not found'), { code: 'MCP_LOCAL_NOT_FOUND' }); };
  return {
    read: reader.read,
    async create(name, config, directory) {
      reader.validateName(name);
      const entry = reader.parseServer(entityData(config));
      return mutate(directory, (servers) => {
        if (Object.hasOwn(servers, name)) throw Object.assign(new Error('Project-local MCP server already exists'), { code: 'MCP_LOCAL_EXISTS' });
        servers[name] = entry;
      });
    },
    async update(name, updates, directory) {
      reader.validateName(name);
      const entry = Object.fromEntries(Object.entries(updates).filter(([key]) => key !== 'name' && key !== 'scope'));
      return mutate(directory, (servers) => {
        if (!Object.hasOwn(servers, name)) missing();
        servers[name] = reader.parseServer(entityData({ ...servers[name], ...entry }));
      });
    },
    async remove(name, directory) {
      reader.validateName(name);
      return mutate(directory, (servers) => {
        if (!Object.hasOwn(servers, name)) missing();
        delete servers[name];
      });
    },
  };
}
