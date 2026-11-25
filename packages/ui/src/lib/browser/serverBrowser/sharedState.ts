import { create } from 'zustand';

import type { ServerBrowserState } from './types';

type PublishedState = { readonly runtimeKey: string; readonly state: ServerBrowserState };

type ServerBrowserSharedState = {
  readonly published: Readonly<Record<string, PublishedState>>;
  readonly followers: Readonly<Record<string, number>>;
  publish: (guestId: string, runtimeKey: string, state: ServerBrowserState) => void;
  clear: (guestId: string) => void;
  follow: (guestId: string) => () => void;
};

export const useServerBrowserSharedState = create<ServerBrowserSharedState>((set) => {
  const countFollower = (guestId: string, delta: number) => set((current) => ({
    followers: { ...current.followers, [guestId]: Math.max(0, (current.followers[guestId] ?? 0) + delta) },
  }));
  return {
    published: {},
    followers: {},
    publish: (guestId, runtimeKey, state) => set((current) => {
      const previous = current.published[guestId];
      const unchanged = previous?.runtimeKey === runtimeKey
        && state.version !== undefined
        && previous.state.version === state.version;
      return unchanged ? current : { published: { ...current.published, [guestId]: { runtimeKey, state } } };
    }),
    clear: (guestId) => set((current) => {
      if (!(guestId in current.published)) return current;
      const published = { ...current.published };
      delete published[guestId];
      return { published };
    }),
    follow: (guestId) => {
      countFollower(guestId, 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        countFollower(guestId, -1);
      };
    },
  };
});

type SharedStateReading = Pick<ServerBrowserSharedState, 'published' | 'followers'>;

export const publishedServerBrowserState = (
  shared: SharedStateReading,
  guestId: string,
  runtimeKey: string,
): ServerBrowserState | null => {
  const entry = shared.published[guestId];
  return entry && entry.runtimeKey === runtimeKey ? entry.state : null;
};

export const hasServerBrowserFollower = (shared: SharedStateReading, guestId: string): boolean => (
  (shared.followers[guestId] ?? 0) > 0
);
