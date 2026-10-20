import { create } from 'zustand';

import type { GuestPlanAnnotation, PlansAnnotateRequest } from '@openchamber/sdk';

/**
 * The hidden frames that describe an extension's plans. One frame per
 * extension and worktree, pinned to that worktree and to no session, kept
 * while some part of the Plans area shows that worktree's plans. The frame
 * registers an annotator once its guest has connected; a request for another
 * worktree never reaches it.
 */

/**
 * `timeout`: the frame never answered; `unavailable`: no frame could be asked
 * (never loaded, closed mid-call, extension changed); `error`: the guest's own
 * answer, shown as the extension wrote it.
 */
export type GuestPlanAnnotateOutcome =
  | { ok: true; annotations: GuestPlanAnnotation[] }
  | { ok: false; reason: 'timeout' | 'unavailable' }
  | { ok: false; reason: 'error'; message: string };

type GuestPlanAnnotator = (request: PlansAnnotateRequest) => Promise<GuestPlanAnnotateOutcome>;

const guestPlanFrameKey = (guestId: string, directory: string): string => JSON.stringify([guestId, directory]);

const annotators = new Map<string, GuestPlanAnnotator>();
const listeners = new Set<() => void>();

const notify = (): void => {
  for (const listener of listeners) listener();
};

export const registerGuestPlanAnnotator = (guestId: string, directory: string, annotator: GuestPlanAnnotator): (() => void) => {
  const key = guestPlanFrameKey(guestId, directory);
  annotators.set(key, annotator);
  notify();
  return () => {
    if (annotators.get(key) === annotator) {
      annotators.delete(key);
      notify();
    }
  };
};

/** The annotator once one is registered for this extension and worktree, or `null` at the deadline. */
export const waitForGuestPlanAnnotator = (guestId: string, directory: string, timeoutMs: number): Promise<GuestPlanAnnotator | null> => {
  const key = guestPlanFrameKey(guestId, directory);
  const existing = annotators.get(key);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve) => {
    const finish = (value: GuestPlanAnnotator | null) => {
      listeners.delete(check);
      clearTimeout(timer);
      resolve(value);
    };
    const check = () => {
      const annotator = annotators.get(key);
      if (annotator) finish(annotator);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    listeners.add(check);
  });
};

type GuestPlanFrame = { key: string; guestId: string; directory: string };

type GuestPlanFrameState = {
  frames: Record<string, GuestPlanFrame & { holders: number }>;
  /** Keep the frame for this extension and worktree until the returned release runs. */
  hold: (guestId: string, directory: string) => () => void;
};

/** A frame without holders stays this long, so moving between list and plan does not reload it. */
const FRAME_LINGER_MS = 15_000;

export const useGuestPlanFrameStore = create<GuestPlanFrameState>((set, get) => ({
  frames: {},
  hold: (guestId, directory) => {
    const key = guestPlanFrameKey(guestId, directory);
    const current = get().frames[key];
    set({ frames: { ...get().frames, [key]: { key, guestId, directory, holders: (current?.holders ?? 0) + 1 } } });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const frame = get().frames[key];
      if (!frame) return;
      set({ frames: { ...get().frames, [key]: { ...frame, holders: frame.holders - 1 } } });
      setTimeout(() => {
        const latest = get().frames[key];
        if (!latest || latest.holders > 0) return;
        const { [key]: _removed, ...rest } = get().frames;
        set({ frames: rest });
      }, FRAME_LINGER_MS);
    };
  },
}));
