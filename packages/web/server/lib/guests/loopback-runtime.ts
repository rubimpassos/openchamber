import { onExtensionStoreWrite } from './persist.js';
import { authorizeLoopbackRequest, LoopbackError } from './loopback-policy.js';
import { LOOPBACK_CLOCK } from './loopback-proxy.js';
import type { LoopbackClock } from './loopback-proxy.js';
import type { AuthorizedLoopbackTarget, LoopbackAdmission } from './loopback-policy.js';

type ActiveLoopbackRequest = {
  readonly request: LoopbackAdmission;
  readonly controller: AbortController;
  target: AuthorizedLoopbackTarget | null;
};
export type LoopbackLease = {
  readonly signal: AbortSignal;
  readonly authorize: () => Promise<AuthorizedLoopbackTarget>;
  readonly close: () => void;
};
export type LoopbackRuntime = {
  readonly open: (request: LoopbackAdmission) => LoopbackLease;
  readonly dispose: () => void;
};

export const createLoopbackRuntime = (persistPath: string, clock: LoopbackClock = LOOPBACK_CLOCK): LoopbackRuntime => {
  const active = new Map<string, Set<ActiveLoopbackRequest>>();
  const deadlines = new Set<ReturnType<typeof setTimeout>>();
  let accepting = true;
  let revision = 0;
  let checking = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (accepting && active.size > 0 && timer === undefined) timer = clock.setTimeout(tick, 1_000);
  };
  const revoked = () => new LoopbackError(403, 'NOT_GRANTED', 'Loopback authorization changed.');
  const abortGuest = (entries: Iterable<ActiveLoopbackRequest>, error: LoopbackError) => {
    for (const entry of entries) entry.controller.abort(error);
  };
  const recheck = async () => {
    if (!accepting || checking || active.size === 0) return;
    checking = true;
    const version = revision;
    try {
      await Promise.all([...active.values()].map(async (entries) => {
        const ready = [...entries].filter((entry) => entry.target);
        const first = ready[0];
        if (!first) return;
        const deadline = clock.setTimeout(() => abortGuest(entries, revoked()), 1_000);
        deadlines.add(deadline);
        try {
          const target = await authorizeLoopbackRequest(first.request, persistPath);
          for (const entry of ready) {
            if (entry.target && JSON.stringify(entry.target.scope) !== JSON.stringify(target.scope)) entry.controller.abort(revoked());
          }
        } catch (error) {
          abortGuest(entries, error instanceof LoopbackError ? error : revoked());
        } finally {
          clock.clearTimeout(deadline);
          deadlines.delete(deadline);
        }
      }));
    } finally {
      checking = false;
      if (version !== revision) void recheck();
    }
  };
  const tick = async () => {
    timer = undefined;
    await recheck();
    schedule();
  };
  const unsubscribe = onExtensionStoreWrite((path) => {
    if (path !== persistPath) return;
    revision += 1;
    void recheck();
  });
  const open = (request: LoopbackAdmission): LoopbackLease => {
    if (!accepting) throw new LoopbackError(502, 'HOST_UNAVAILABLE', 'Loopback runtime is stopped.');
    const entries = active.get(request.guestId) ?? new Set<ActiveLoopbackRequest>();
    if (entries.size >= 16) throw new LoopbackError(403, 'HOST_REJECTED', 'Loopback stream limit reached.');
    const entry: ActiveLoopbackRequest = { request, controller: new AbortController(), target: null };
    entries.add(entry);
    active.set(request.guestId, entries);
    schedule();
    return {
      signal: entry.controller.signal,
      async authorize() {
        let version = revision;
        let target = await authorizeLoopbackRequest(request, persistPath);
        if (accepting && version !== revision && !entry.controller.signal.aborted) {
          version = revision;
          const current = await authorizeLoopbackRequest(request, persistPath);
          if (JSON.stringify(current.scope) !== JSON.stringify(target.scope)) throw revoked();
          target = current;
        }
        if (!accepting || version !== revision || entry.controller.signal.aborted) throw revoked();
        entry.target = target;
        return target;
      },
      close() {
        if (!entries.delete(entry)) return;
        if (entries.size === 0) active.delete(request.guestId);
        if (active.size === 0) {
          clock.clearTimeout(timer);
          timer = undefined;
        }
        entry.controller.abort(revoked());
      },
    };
  };
  return {
    open,
    dispose() {
      accepting = false;
      unsubscribe();
      clock.clearTimeout(timer);
      for (const deadline of deadlines) clock.clearTimeout(deadline);
      deadlines.clear();
      for (const entries of active.values()) abortGuest(entries, revoked());
      active.clear();
    },
  };
};
