import * as fileConfig from './mcp.js';
import { createLocalMcpStore } from './mcp-local.js';

/** Keep personal project entries outside the files owned by OpenCode. */
export const createMcpConfigRuntime = ({ dataDir, isLocalScopeSupported = () => false }) => {
  const local = createLocalMcpStore({ dataDir });
  const readLocal = (directory) => directory ? local.read(directory) : null;
  const localEntry = (name, directory) => {
    const document = readLocal(directory);
    if (!document || !Object.hasOwn(document.servers, name)) return null;
    return { ...document.servers[name], name, scope: 'local', path: document.path, legacy: false };
  };
  const assertLocalScope = (directory) => {
    if (!directory) {
      throw Object.assign(new Error('Local project scope requires a project directory'), { status: 400 });
    }
    if (!isLocalScopeSupported()) {
      throw Object.assign(new Error('Local project MCP servers require OpenCode managed by OpenChamber'), { status: 501 });
    }
  };
  const assertExpectedOwner = (entry, scope) => {
    if (scope === undefined) return;
    if (!['user', 'project', 'local'].includes(scope)) {
      throw Object.assign(new Error('Invalid MCP scope'), { status: 400 });
    }
    if (entry?.scope !== scope) {
      throw Object.assign(new Error('MCP server scope changed; reopen the server before editing'), { status: 409 });
    }
  };

  return {
    getMcpCapabilities: () => ({ projectLocal: isLocalScopeSupported() }),
    listMcpConfigs(directory) {
      const entries = new Map(fileConfig.listMcpConfigs(directory).map((entry) => [entry.name, entry]));
      const document = readLocal(directory);
      for (const [name, config] of Object.entries(document?.servers ?? {})) {
        entries.set(name, { ...config, name, scope: 'local', path: document.path, legacy: false });
      }
      return [...entries.values()];
    },
    getMcpConfig(name, directory) {
      return localEntry(name, directory) ?? fileConfig.getMcpConfig(name, directory);
    },
    async createMcpConfig(name, config, directory, scope = 'user') {
      if (!['user', 'project', 'local'].includes(scope)) {
        throw Object.assign(new Error('Invalid MCP scope'), { status: 400 });
      }
      if (scope === 'local') assertLocalScope(directory);
      if (localEntry(name, directory) || fileConfig.getMcpConfig(name, directory)) {
        throw Object.assign(new Error(`MCP server "${name}" already exists`), { status: 409 });
      }
      return scope === 'local'
        ? local.create(name, config, directory)
        : fileConfig.createMcpConfig(name, config, directory, scope);
    },
    async updateMcpConfig(name, updates, directory) {
      const entry = localEntry(name, directory) ?? fileConfig.getMcpConfig(name, directory);
      assertExpectedOwner(entry, updates.scope);
      if (entry?.scope === 'local') {
        assertLocalScope(directory);
        const { name: _name, scope: _scope, ...config } = updates;
        return local.update(name, config, directory);
      }
      return fileConfig.updateMcpConfig(name, updates, directory);
    },
    async deleteMcpConfig(name, directory, expectedScope) {
      const entry = localEntry(name, directory) ?? fileConfig.getMcpConfig(name, directory);
      assertExpectedOwner(entry, expectedScope);
      if (entry?.scope === 'local') {
        assertLocalScope(directory);
        return local.remove(name, directory);
      }
      return fileConfig.deleteMcpConfig(name, directory);
    },
  };
};
