import React from 'react';

import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { isGuestActive } from './capabilities';
import { useGuestsStore } from './store';
import type { InstalledGuest } from './types';

/** Package identity excludes catalog-only metadata (for example update availability). */
export const guestPackageIdentity = (guest: InstalledGuest): string => JSON.stringify([
  guest.id, guest.source, guest.path, guest.origin, guest.version,
  guest.entry, guest.backgroundEntry, guest.statusEntry, guest.origins, guest.loopback,
]);

export const automaticBackgrounds = (guests: readonly InstalledGuest[], runtimeKey: string) => {
  const selected = new Map<string, { readonly guestId: string; readonly key: string }>();
  for (const guest of guests) {
    if (guest.backgroundStart !== 'automatic' || !guest.backgroundEntry || !isGuestActive(guest)) continue;
    selected.set(guest.id, { guestId: guest.id, key: JSON.stringify([runtimeKey, guestPackageIdentity(guest)]) });
  }
  return [...selected.values()];
};

/** Each app window has one GuestHosts root; keyed children retire the old document before loading its replacement. */
export const useAutomaticBackgrounds = () => {
  const guests = useGuestsStore((state) => state.guests);
  const catalogRuntime = useGuestsStore((state) => state.runtimeKey);
  const runtimeKey = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeKey, getRuntimeKey);
  return React.useMemo(() => catalogRuntime === runtimeKey ? automaticBackgrounds(guests, runtimeKey) : [],
    [catalogRuntime, guests, runtimeKey]);
};
