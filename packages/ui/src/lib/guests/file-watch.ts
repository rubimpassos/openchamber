import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { runtimeFetch } from '@/lib/runtime-fetch';

type WatchResponse = { watchId?: unknown; leaseMs?: unknown };

/**
 * A guest frame's `host.watchFiles`: holds a lease on the server
 * (`POST /api/guests/:id/files/watch`, renewed at half the lease) and calls
 * `onChange` with the changed paths from `openchamber:guest-files-changed`.
 * Resolves to `null` when the server cannot watch (an older server, a
 * refused grant), so the caller can reject and the guest keeps polling.
 */
export const watchGuestFiles = async (input: {
  guestId: string;
  directory: string;
  paths: string[];
  onChange: (paths: string[]) => void;
}): Promise<(() => void) | null> => {
  const headers = new Headers({ 'Content-Type': 'application/json', 'x-opencode-directory': input.directory });
  const lease = async (watchId?: string): Promise<{ watchId: string; leaseMs: number } | null> => {
    const response = await runtimeFetch(`/api/guests/${input.guestId}/files/watch`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ paths: input.paths, ...(watchId ? { watchId } : {}) }),
    }).catch(() => null);
    if (!response?.ok) return null;
    const body = await response.json().catch(() => null) as WatchResponse | null;
    if (typeof body?.watchId !== 'string') return null;
    return { watchId: body.watchId, leaseMs: typeof body.leaseMs === 'number' && body.leaseMs > 2_000 ? body.leaseMs : 60_000 };
  };

  const first = await lease();
  if (!first) return null;
  let watchId = first.watchId;
  let stopped = false;

  const unsubscribe = subscribeOpenchamberEvents((event) => {
    if (event.type !== 'guest-files-changed' || event.watchId !== watchId || event.guestId !== input.guestId) return;
    input.onChange(event.paths);
  });
  const renew = setInterval(() => {
    void lease(watchId).then((next) => {
      // A restarted server forgot the watch: take the new id it hands out.
      if (next && !stopped) watchId = next.watchId;
    });
  }, Math.floor(first.leaseMs / 2));

  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(renew);
    unsubscribe();
    void runtimeFetch(`/api/guests/${input.guestId}/files/watch/${encodeURIComponent(watchId)}`, { method: 'DELETE' }).catch(() => undefined);
  };
};
