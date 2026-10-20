import type { McpEntity } from './config-v2.js';

export interface LocalMcpSnapshot {
  readonly path: string;
  readonly identity: string;
  readonly servers: Readonly<Record<string, McpEntity>>;
  readonly exists: boolean;
}

export interface LocalMcpStore {
  read(directory: string): LocalMcpSnapshot;
  create(name: string, config: McpEntity, directory: string): Promise<{ path: string }>;
  update(name: string, updates: Partial<McpEntity>, directory: string): Promise<{ path: string }>;
  remove(name: string, directory: string): Promise<{ path: string }>;
}

export function createLocalMcpStore(options: { readonly dataDir: string }): LocalMcpStore;
