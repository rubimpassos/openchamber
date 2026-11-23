import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { hasProperties, isBoolean, isPlainObject, isString } from '../shared/guards.js';
import { protectedSelectionReader } from './selections-reader.js';
import { readServiceState, setSubject } from './service-client.js';
import type { ConnectionId } from './service/contract.js';

const projectDocument = z.object({ identity: z.string().min(1) });

type AgentSubjectSyncOptions = {
  readonly dataDir: string;
  readonly clientConfigPath: () => string;
  readonly log?: (code: unknown) => void;
  readonly retryMs?: number;
};
type SyncResult = { readonly ok: true } | { readonly ok: false; readonly code: unknown };

/** All common sessions share this union, including projects that are not open. */
export function agentSubjectConnections(dataDir: string): ConnectionId[] {
  const directory = path.join(dataDir, 'mcp-protected');
  let files: string[];
  try { files = fs.readdirSync(directory); }
  catch (error) { if (hasProperties(error) && error.code === 'ENOENT') return []; throw error; }
  const reader = protectedSelectionReader(dataDir, { fs, path, isBoolean, isPlainObject, isString });
  const connections = new Set<ConnectionId>();
  for (const name of files.sort().filter((name) => name === 'global.json' || /^project-[0-9a-f]{64}\.json$/.test(name))) {
    const file = path.join(directory, name);
    const identity = name === 'global.json' ? null : projectDocument.parse(JSON.parse(fs.readFileSync(file, 'utf8'))).identity;
    const { servers } = reader.readDocument(file, identity);
    for (const entry of Object.values(servers)) if (!entry.disabled) connections.add(entry.connection);
  }
  return [...connections].sort();
}

/**
 * Re-read inside the queue so a slow older push cannot overwrite a newer selection. A push that
 * fails leaves the service with the old connections, a removed one included, so it is tried again
 * every `retryMs` until the service takes it; a later change replaces the retry. `push()` resolves
 * `{ ok: true }` or `{ ok: false, code }` for the attempt it made.
 */
export function createAgentSubjectSync({ dataDir, clientConfigPath, log = (code) => console.warn('[protected-mcp] agent_subject_sync_failed', { code }), retryMs = 10_000 }: AgentSubjectSyncOptions) {
  let pending: Promise<unknown> = Promise.resolve();
  let retry: ReturnType<typeof setTimeout> | null = null;
  const attempt = async (): Promise<SyncResult> => {
    try {
      const connections = agentSubjectConnections(dataDir);
      const result = await setSubject('agent', connections, { clientConfigPath: clientConfigPath() });
      if (result.ok) return { ok: true };
      log(result.code);
      return { ok: false, code: result.code };
    } catch (error) {
      const code = hasProperties(error) ? error.code ?? 'selections_unreadable' : 'selections_unreadable';
      log(code);
      return { ok: false, code };
    }
  };
  const push = () => {
    clearTimeout(retry ?? undefined);
    retry = null;
    const result = pending.then(attempt).then((answer) => {
      if (!answer.ok && retry === null) {
        retry = setTimeout(() => { retry = null; void push(); }, retryMs);
        retry.unref?.();
      }
      return answer;
    });
    pending = result.catch(() => {});
    return result;
  };
  return {
    push,
    async start() {
      try {
        const state = await readServiceState({ clientConfigPath: clientConfigPath() });
        if (state.state === 'available') await push();
      } catch (error) {
        log(hasProperties(error) ? error.code ?? 'service_unavailable' : 'service_unavailable');
      }
    },
    stop() { clearTimeout(retry ?? undefined); retry = null; },
  };
}
