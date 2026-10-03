import { describe, expect, test } from 'bun:test';

import { useGuestBadgeStore } from './badge-store.ts';
import { useGuestsStore } from './store.ts';
import type { InstalledGuest } from './types.ts';

describe('useGuestBadgeStore', () => {
  test('keeps counts per guest, treats null and zero as clear, and skips no-op writes', () => {
    useGuestBadgeStore.setState({ countByGuest: {} });
    const store = useGuestBadgeStore.getState();
    store.setBadge('tasks-demo', 3);
    store.setBadge('other', 1);
    expect(useGuestBadgeStore.getState().countByGuest).toEqual({ 'tasks-demo': 3, other: 1 });

    const before = useGuestBadgeStore.getState().countByGuest;
    store.setBadge('tasks-demo', 3);
    expect(useGuestBadgeStore.getState().countByGuest).toBe(before);

    store.setBadge('tasks-demo', 0);
    expect(useGuestBadgeStore.getState().countByGuest).toEqual({ other: 1 });
    store.setBadge('other', null);
    expect(useGuestBadgeStore.getState().countByGuest).toEqual({});

    const empty = useGuestBadgeStore.getState().countByGuest;
    store.clearBadge('missing');
    expect(useGuestBadgeStore.getState().countByGuest).toBe(empty);
  });
});

for (const mode of [undefined, 'unread', 'count'] as const) {
  test(`panel opening preserves only count mode when badge mode is ${mode}`, () => {
    // Given
    const guest: InstalledGuest = { id: 'badge', name: 'Badge', icon: 'window', panelBadge: mode,
      capabilities: { requested: [], granted: [] } };
    useGuestsStore.getState().resetForRuntimeSwitch('badge-runtime');
    useGuestsStore.getState().replaceCatalog([guest], 'badge-runtime');
    const badges = useGuestBadgeStore.getState();
    badges.setBadge('badge', 4);
    // When
    badges.panelOpened('badge');
    // Then
    expect(useGuestBadgeStore.getState().countByGuest.badge).toBe(mode === 'count' ? 4 : undefined);
  });
}

for (const transition of ['disable', 'revoke', 'uninstall', 'runtime'] as const) {
  test(`clears a count badge when ${transition} retires the guest`, () => {
    // Given
    const guest: InstalledGuest = { id: 'badge', name: 'Badge', icon: 'window', panelBadge: 'count',
      capabilities: { requested: ['loopback'], granted: ['loopback'] } };
    useGuestsStore.getState().resetForRuntimeSwitch('badge-runtime');
    useGuestsStore.getState().replaceCatalog([guest], 'badge-runtime');
    useGuestBadgeStore.getState().setBadge('badge', 4);
    // When
    switch (transition) {
      case 'disable': useGuestsStore.getState().replaceCatalog([{ ...guest, enabled: false }], 'badge-runtime'); break;
      case 'revoke': useGuestsStore.getState().replaceCatalog([{ ...guest, capabilities: { requested: ['loopback'], granted: [] } }], 'badge-runtime'); break;
      case 'uninstall': useGuestsStore.getState().replaceCatalog([], 'badge-runtime'); break;
      case 'runtime': useGuestsStore.getState().resetForRuntimeSwitch('next-runtime'); break;
      default: { const exhaustive: never = transition; throw new Error(exhaustive); }
    }
    // Then
    expect(useGuestBadgeStore.getState().countByGuest.badge).toBeUndefined();
  });
}
