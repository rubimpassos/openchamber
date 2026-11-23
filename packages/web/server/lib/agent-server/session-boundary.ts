import path from 'node:path';
import { isRecord, isString } from '../shared/guards.js';
import type { JsonValue } from '../event-stream/contracts.js';

const spaceRoots = ['/spaces', '/var/lib/openchamber-spaces', '/var/lib/private/openchamber-spaces', '/var/lib/openchamber-hostd/spaces'];
const directoryFields = new Set(['directory', 'worktree', 'projectDirectory']);
const sessionFields = new Set(['id', 'sessionId', 'sessionID']);

export function isAgentPayloadAllowed(payload: JsonValue, isSpaceSession: (id: string) => boolean = () => false): boolean {
  const pending: { readonly value: JsonValue | undefined; readonly depth: number }[] = [{ value: payload, depth: 0 }];
  for (let entry = pending.pop(); entry; entry = pending.pop()) {
    const { value, depth } = entry;
    if (depth > 64) return false;
    if (!isRecord(value) && !Array.isArray(value)) continue;
    for (const [key, entry] of Object.entries(value)) {
      if (isSpaceSession(key)) return false;
      if (isString(entry)) {
        if (sessionFields.has(key) && isSpaceSession(entry)) return false;
        if (directoryFields.has(key)) {
          const normalized = path.posix.normalize(entry.replaceAll('\\', '/')).toLowerCase();
          if (spaceRoots.some((root) => normalized === root || normalized.startsWith(`${root}/`))) return false;
        }
      } else if (isRecord(entry) || Array.isArray(entry)) pending.push({ value: entry, depth: depth + 1 });
    }
  }
  return true;
}
