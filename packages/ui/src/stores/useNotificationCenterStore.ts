/**
 * The notification center as this client knows it: one read of the server's
 * list per runtime and connection, then the `notification-center.changed`
 * events. The server owns the entries and their read state; a mark-read here
 * is applied when the server's answer or event arrives, never guessed.
 */
import { create } from 'zustand';

import {
  NotificationCenterUnsupportedError,
  clearNotificationCenter,
  fetchNotificationCenter,
  markNotificationCenterRead,
  type NotificationCenterChange,
  type NotificationCenterEntry,
  type NotificationCenterReadTarget,
} from '@/lib/notificationCenter';

/**
 * `unsupported`: the server has no notification center (an older build), so
 * nothing is shown. `error`: the last read failed; entries from this same
 * server stay as they were.
 */
type NotificationCenterStatus = 'idle' | 'loading' | 'ready' | 'unsupported' | 'error';

type NotificationCenterState = {
  status: NotificationCenterStatus;
  /** Newest first. */
  entries: NotificationCenterEntry[];
  load: () => Promise<void>;
  resetForRuntime: () => void;
  applyChange: (change: NotificationCenterChange) => void;
  markRead: (target: NotificationCenterReadTarget) => Promise<void>;
  /** Marks a session's entries read, asking the server only when this client has an unread one. */
  markSessionRead: (sessionId: string) => void;
  clear: () => Promise<void>;
};

let loadGeneration = 0;

const applyRead = (entries: NotificationCenterEntry[], ids: string[], readAt: number): NotificationCenterEntry[] => {
  if (ids.length === 0) return entries;
  const changed = new Set(ids);
  return entries.map((entry) => (changed.has(entry.id) && entry.readAt === null ? { ...entry, readAt } : entry));
};

export const useNotificationCenterStore = create<NotificationCenterState>()((set, get) => ({
  status: 'idle',
  entries: [],

  load: async () => {
    const generation = ++loadGeneration;
    if (get().status !== 'ready') set({ status: 'loading' });
    try {
      const entries = await fetchNotificationCenter();
      if (generation !== loadGeneration) return;
      set({ status: 'ready', entries });
    } catch (error) {
      if (generation !== loadGeneration) return;
      if (error instanceof NotificationCenterUnsupportedError) {
        set({ status: 'unsupported', entries: [] });
        return;
      }
      set({ status: 'error' });
    }
  },

  resetForRuntime: () => {
    // Another server has other notifications; nothing from the previous one stays.
    loadGeneration += 1;
    set({ status: 'idle', entries: [] });
  },

  applyChange: (change) => {
    if (change.change === 'cleared') {
      set({ entries: [] });
      return;
    }
    if (change.change === 'read') {
      set((state) => ({ entries: applyRead(state.entries, change.ids, change.readAt) }));
      return;
    }
    set((state) => (state.entries.some((entry) => entry.id === change.entry.id)
      ? state
      : { entries: [change.entry, ...state.entries] }));
  },

  markRead: async (target) => {
    const { ids, readAt } = await markNotificationCenterRead(target);
    set((state) => ({ entries: applyRead(state.entries, ids, readAt) }));
  },

  markSessionRead: (sessionId) => {
    const { status, entries } = get();
    if (status !== 'ready') return;
    if (!entries.some((entry) => entry.sessionId === sessionId && entry.readAt === null)) return;
    // On failure the entries stay unread here and on the server; the next view tries again.
    void get().markRead({ sessionId }).catch(() => undefined);
  },

  clear: async () => {
    await clearNotificationCenter();
    set({ entries: [] });
  },
}));

export const selectNotificationCenterUnread = (state: NotificationCenterState): number =>
  state.entries.reduce((count, entry) => (entry.readAt === null ? count + 1 : count), 0);
