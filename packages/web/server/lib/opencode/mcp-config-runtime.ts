import * as fileConfig from './mcp.js';
import { createLocalMcpStore } from './mcp-local.js';
import type { McpEntity } from './config-v2.js';
import type { OpenCodeConfigLayer } from './config-files.js';

type McpConfigEntry = NonNullable<ReturnType<typeof fileConfig.getMcpConfig>> | (McpEntity & {
  readonly name: string;
  readonly scope: 'local';
  readonly path: string;
  readonly legacy: false;
});
interface McpConfigRuntimeOptions {
  readonly dataDir: string;
  readonly isLocalScopeSupported?: (() => boolean) | undefined;
}

/** Keep personal project entries outside the files owned by OpenCode. */
export const createMcpConfigRuntime = ({ dataDir, isLocalScopeSupported = () => false }: McpConfigRuntimeOptions) => {
  const local = createLocalMcpStore({ dataDir });
  const readLocal = (directory: string | null | undefined) => directory ? local.read(directory) : null;
  const localEntry = (name: string, directory: string | null | undefined): McpConfigEntry | null => {
    const document = readLocal(directory);
    if (!document || !Object.hasOwn(document.servers, name)) return null;
    const config = document.servers[name];
    if (config === undefined) return null;
    return { ...config, name, scope: 'local', path: document.path, legacy: false };
  };
  const assertLocalScope: (directory: string | null | undefined) => asserts directory is string = (directory) => {
    if (!directory) {
      throw Object.assign(new Error('Local project scope requires a project directory'), { status: 400 });
    }
    if (!isLocalScopeSupported()) {
      throw Object.assign(new Error('Local project MCP servers require OpenCode managed by OpenChamber'), { status: 501 });
    }
  };
  const assertExpectedOwner = (entry: McpConfigEntry | null, scope: unknown) => {
    if (scope === undefined) return;
    if (scope !== 'user' && scope !== 'project' && scope !== 'local') {
      throw Object.assign(new Error('Invalid MCP scope'), { status: 400 });
    }
    if (entry?.scope !== scope) {
      throw Object.assign(new Error('MCP server scope changed; reopen the server before editing'), { status: 409 });
    }
  };

  return {
    getMcpCapabilities: () => ({ projectLocal: isLocalScopeSupported() }),
    listMcpConfigs(directory: string | null | undefined): McpConfigEntry[] {
      const entries = new Map<string, McpConfigEntry>(fileConfig.listMcpConfigs(directory ?? null).map((entry) => [entry.name, entry]));
      const document = readLocal(directory);
      if (document) {
        for (const [name, config] of Object.entries(document.servers)) {
          entries.set(name, { ...config, name, scope: 'local', path: document.path, legacy: false });
        }
      }
      return [...entries.values()];
    },
    getMcpConfig(name: string, directory: string | null | undefined) {
      return localEntry(name, directory) ?? fileConfig.getMcpConfig(name, directory ?? null);
    },
    async createMcpConfig(name: string, config: OpenCodeConfigLayer, directory: string | null | undefined, scope = 'user') {
      if (!['user', 'project', 'local'].includes(scope)) {
        throw Object.assign(new Error('Invalid MCP scope'), { status: 400 });
      }
      let localDirectory: string | null = null;
      if (scope === 'local') {
        assertLocalScope(directory);
        localDirectory = directory;
      }
      if (localEntry(name, directory) || fileConfig.getMcpConfig(name, directory ?? null)) {
        throw Object.assign(new Error(`MCP server "${name}" already exists`), { status: 409 });
      }
      if (localDirectory !== null) {
        return local.create(name, config, localDirectory);
      }
      return fileConfig.createMcpConfig(name, config, directory ?? null, scope);
    },
    async updateMcpConfig(name: string, updates: OpenCodeConfigLayer | null | undefined, directory: string | null | undefined) {
      const entry = localEntry(name, directory) ?? fileConfig.getMcpConfig(name, directory ?? null);
      if (updates == null) throw new TypeError(`Cannot read properties of ${updates} (reading 'scope')`);
      assertExpectedOwner(entry, updates.scope);
      if (entry?.scope === 'local') {
        assertLocalScope(directory);
        const { name: _name, scope: _scope, ...config } = updates;
        return local.update(name, config, directory);
      }
      return fileConfig.updateMcpConfig(name, updates, directory ?? null);
    },
    async deleteMcpConfig(name: string, directory: string | null | undefined, expectedScope?: unknown) {
      const entry = localEntry(name, directory) ?? fileConfig.getMcpConfig(name, directory ?? null);
      assertExpectedOwner(entry, expectedScope);
      if (entry?.scope === 'local') {
        assertLocalScope(directory);
        return local.remove(name, directory);
      }
      return fileConfig.deleteMcpConfig(name, directory ?? null);
    },
  };
};
