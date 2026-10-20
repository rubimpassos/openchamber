import path from 'node:path';
import { createLocalMcpStore } from '../../web/server/lib/opencode/mcp-local.js';
import { materializeLocalMcpPlugin } from '../../web/server/lib/opencode/mcp-local-plugin.js';
import { appendManagedPlugin } from '../../web/server/lib/opencode/managed-plugin-config.js';
import { getOpenChamberDataDir } from './openchamberSessionState';

const localMcpDataDir = () => process.env.OPENCHAMBER_DATA_DIR
  ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
  : getOpenChamberDataDir();

export const localMcpStore = () => createLocalMcpStore({ dataDir: localMcpDataDir() });

/** Called only for owned server launches, including an empty local store. */
export const withLocalMcpPlugin = async (env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> => {
  const directory = await materializeLocalMcpPlugin({ dataDir: localMcpDataDir() });
  return {
    ...env,
    OPENCODE_CONFIG_CONTENT: appendManagedPlugin(env.OPENCODE_CONFIG_CONTENT, directory, 'project-local MCP plugin'),
  };
};
