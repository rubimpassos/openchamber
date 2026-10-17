import { createStore } from 'zustand/vanilla';
import type { FixLoop, FixLoopConfig, PrFixLoopUpdatedEvent } from '@/lib/prFixLoop';
import type { CreatePrFixLoop, PrFixLoopAPI } from '@/lib/prFixLoopApi';

type PrFixLoopState = {
  readonly runtimeKey: string;
  readonly loops: readonly FixLoop[];
  readonly loadState: 'idle' | 'loading' | 'ready' | 'error';
  readonly loadError: string | null;
  readonly failedLoopIds: readonly string[];
  refresh: () => Promise<void>;
  applyEvent: (event: PrFixLoopUpdatedEvent, runtimeKey: string) => void;
  create: (input: CreatePrFixLoop) => Promise<void>;
  update: (id: string, config: Partial<FixLoopConfig>) => Promise<void>;
  stop: (id: string) => Promise<void>;
  resume: (id: string) => Promise<void>;
  approve: (id: string, receiptId: string) => Promise<void>;
  dismiss: (id: string) => Promise<void>;
  reset: () => void;
};

/** One request owner per runtime; event revisions protect an in-flight snapshot. */
export function createPrFixLoopProjection(dependencies: {
  readonly api: PrFixLoopAPI;
  readonly runtimeKey: () => string;
}) {
  const { api, runtimeKey } = dependencies;
  return createStore<PrFixLoopState>((set, get) => {
    let generation = 0;
    let revision = 0;
    const mutations = new Map<string, number>();
    const removed = new Set<string>();
    let pending: Promise<void> | null = null;
    let refreshAgain = false;
    const capture = () => {
      const key = runtimeKey();
      const epoch = generation;
      return () => epoch === generation && key === runtimeKey();
    };

    const upsert = (loop: FixLoop) => {
      if (removed.has(loop.id)) return;
      const current = get().loops.find((entry) => entry.id === loop.id);
      if (current && current.updatedAt > loop.updatedAt) return;
      mutations.set(loop.id, ++revision);
      const unchanged = current && JSON.stringify(current) === JSON.stringify(loop);
      const failedLoopIds = get().failedLoopIds.filter((id) => id !== loop.id);
      if (unchanged && failedLoopIds.length === get().failedLoopIds.length) return;
      set((state) => ({
        runtimeKey: runtimeKey(),
        loops: unchanged ? state.loops : current ? state.loops.map((entry) => entry.id === loop.id ? loop : entry) : [...state.loops, loop],
        failedLoopIds,
        loadError: state.loadState === 'error' ? state.loadError : failedLoopIds.length ? 'Malformed fix-loop records were retained.' : null,
      }));
    };

    const remove = (id: string) => {
      mutations.set(id, ++revision);
      removed.add(id);
      if (get().loops.some((loop) => loop.id === id) || get().failedLoopIds.includes(id)) {
        set((state) => {
          const failedLoopIds = state.failedLoopIds.filter((entry) => entry !== id);
          return { loops: state.loops.filter((loop) => loop.id !== id), failedLoopIds,
            loadError: state.loadState === 'error' ? state.loadError : failedLoopIds.length ? 'Malformed fix-loop records were retained.' : null };
        });
      }
    };

    const mutate = async (operation: () => Promise<FixLoop>) => {
      const isCurrent = capture();
      const loop = await operation();
      if (isCurrent()) upsert(loop);
    };

    return {
      runtimeKey: runtimeKey(), loops: [], loadState: 'idle', loadError: null, failedLoopIds: [],
      refresh: () => {
        if (get().runtimeKey !== runtimeKey()) get().reset();
        if (pending) {
          refreshAgain = true;
          return pending;
        }
        const isCurrent = capture();
        const task = (async () => {
          do {
            refreshAgain = false;
            const baseline = revision;
            set({ loadState: 'loading' });
            try {
              const snapshot = await api.list();
              if (!isCurrent()) return;
              set((state) => {
                const currentById = new Map(state.loops.map((loop) => [loop.id, loop]));
                const snapshotIds = new Set([...snapshot.loops.map((loop) => loop.id), ...snapshot.rejectedIds]);
                const loops: FixLoop[] = [];
                for (const loop of snapshot.loops) {
                  if (removed.has(loop.id) || (mutations.get(loop.id) ?? 0) > baseline) continue;
                  const current = currentById.get(loop.id);
                  loops.push(current && (current.updatedAt > loop.updatedAt || JSON.stringify(current) === JSON.stringify(loop)) ? current : loop);
                }
                for (const loop of state.loops) {
                  if ((mutations.get(loop.id) ?? 0) > baseline || snapshot.rejectedIds.includes(loop.id)) loops.push(loop);
                  else if (!snapshotIds.has(loop.id)) removed.add(loop.id);
                }
                const unchanged = loops.length === state.loops.length && loops.every((loop, index) => loop === state.loops[index]);
                const failedLoopIds = snapshot.rejectedIds.filter((id) => !removed.has(id) && (mutations.get(id) ?? 0) <= baseline);
                return {
                  loops: unchanged ? state.loops : loops,
                  loadState: 'ready', failedLoopIds,
                  loadError: failedLoopIds.length ? 'Malformed fix-loop records were retained.' : null,
                };
              });
            } catch (error) {
              if (!isCurrent()) return;
              set({ loadState: 'error', loadError: error instanceof Error ? error.message : String(error) });
            }
          } while (refreshAgain && isCurrent());
        })();
        pending = task;
        void task.finally(() => { if (pending === task) pending = null; });
        return task;
      },
      applyEvent: (event, expectedRuntime) => {
        if (expectedRuntime !== runtimeKey() || get().runtimeKey !== expectedRuntime) return;
        if ('loop' in event.properties) upsert(event.properties.loop);
        else remove(event.properties.id);
      },
      create: (input) => mutate(() => api.create(input)),
      update: (id, config) => mutate(() => api.update(id, config)),
      stop: (id) => mutate(() => api.stop(id)),
      resume: (id) => mutate(() => api.resume(id)),
      approve: (id, receiptId) => mutate(() => api.approve(id, receiptId)),
      dismiss: async (id) => {
        const isCurrent = capture();
        await api.dismiss(id);
        if (isCurrent()) remove(id);
      },
      reset: () => {
        generation += 1;
        revision = 0;
        mutations.clear();
        removed.clear();
        pending = null;
        refreshAgain = false;
        set({ runtimeKey: runtimeKey(), loops: [], loadState: 'idle', loadError: null, failedLoopIds: [] });
      },
    };
  });
}
