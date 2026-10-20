import path from 'node:path';
import { withSourceControlFileLock } from '../source-control/file-lock.js';
import { createLocalMcpReader } from './mcp-local-reader.js';
import { ensureLocalMcpDirectory, writeLocalMcpFile } from './mcp-local-files.js';

export function createLocalMcpStore({ dataDir }) {
  const reader = createLocalMcpReader(dataDir);
  const mutate = async (directory, operation) => {
    const target = reader.resolve(directory);
    await ensureLocalMcpDirectory(path.dirname(target.path));
    return withSourceControlFileLock(`${target.path}.lock`, async () => {
      const { servers } = reader.readTarget(target);
      operation(servers);
      await writeLocalMcpFile(target.path, `${JSON.stringify({ version: 1, identity: target.identity, servers }, null, 2)}\n`);
      return { path: target.path };
    });
  };
  const entityData = (config) => {
    const { name: _name, scope: _scope, ...entry } = config;
    // The shared editor sends null to remove an optional OpenCode override.
    return Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== null));
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
      const { name: _name, scope: _scope, ...entry } = updates;
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
