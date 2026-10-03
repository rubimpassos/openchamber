import { create } from 'zustand';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { isGuestActive } from './capabilities';
import { useGuestsStore } from './store';

/**
 * Rail badge counts by guest id, in memory only. A guest writes it through
 * `host.setBadge`; opening an unread-mode panel clears it. Nothing persists
 * across reloads, so a stale count never outlives the frame that set it.
 */
type GuestBadgeState = {
  countByGuest: Record<string, number>;
  setBadge: (guestId: string, count: number | null) => void;
  clearBadge: (guestId: string) => void;
  panelOpened: (guestId: string) => void;
  /** Another instance's extensions are different extensions, even with the same ids. */
  resetForRuntimeSwitch: () => void;
};

export const useGuestBadgeStore = create<GuestBadgeState>((set, get) => ({
  countByGuest: {},
  panelOpened: (guestId) => {
    const guest = useGuestsStore.getState().guests.find((candidate) => candidate.id === guestId);
    if (guest?.panelBadge !== 'count') get().clearBadge(guestId);
  },
  setBadge: (guestId, count) => {
    if (count === null || count <= 0) {
      get().clearBadge(guestId);
      return;
    }
    if (get().countByGuest[guestId] === count) return;
    set((state) => ({ countByGuest: { ...state.countByGuest, [guestId]: count } }));
  },
  clearBadge: (guestId) => {
    if (!(guestId in get().countByGuest)) return;
    set((state) => {
      const { [guestId]: _cleared, ...rest } = state.countByGuest;
      void _cleared;
      return { countByGuest: rest };
    });
  },
  resetForRuntimeSwitch: () => {
    if (Object.keys(get().countByGuest).length > 0) set({ countByGuest: {} });
  },
}));

// Catalog authority, not the visibility of a rail/panel, owns deactivation cleanup.
useGuestsStore.subscribe((state, previous) => {
  if (state.runtimeKey !== previous.runtimeKey) {
    useGuestBadgeStore.getState().resetForRuntimeSwitch();
    return;
  }
  const active = new Set(state.guests.filter(isGuestActive).map((guest) => guest.id));
  for (const id of Object.keys(useGuestBadgeStore.getState().countByGuest)) {
    if (!active.has(id)) useGuestBadgeStore.getState().clearBadge(id);
  }
});
subscribeRuntimeEndpointChanged(() => useGuestBadgeStore.getState().resetForRuntimeSwitch());
