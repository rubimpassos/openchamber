import { hasGuestPage } from '@openchamber/sdk';

import { isGuestActive } from '@/lib/guests/capabilities';
import { loadGuestCatalog } from '@/lib/guests/load-catalog';
import { guestHasSharedSurface } from '@/lib/guests/surfaces';
import { useGuestsStore } from '@/lib/guests/store';
import { isVSCodeRuntime } from '@/lib/desktop';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import { pluginModeFromId } from '@/lib/surfaces/modes';
import { useUIStore } from '@/stores/useUIStore';

/**
 * Opens the context-panel surface for the guest named by `?panel=<guestId>`
 * (a `browser.requestHelp` push deep link, for instance), once its catalog is
 * known. Guest panels do not exist on VS Code or mobile — the same
 * limitation as the guest catalog itself (`loadGuestCatalog`) — so those
 * runtimes no-op. An unknown, disabled, or unapproved guest id is ignored
 * silently: nothing in the URL should surface as an error for a stale link.
 */
export async function openGuestPanelFromRoute(directory: string, guestId: string): Promise<void> {
  const id = guestId.trim();
  const dir = directory.trim();
  if (!id || !dir) return;
  if (isVSCodeRuntime() || isMobileSurfaceRuntime()) return;

  await loadGuestCatalog().catch(() => undefined);

  const guest = useGuestsStore.getState().guests.find((entry) => entry.id === id);
  if (!guest || !isGuestActive(guest) || !(hasGuestPage({ panel: guest }) || guestHasSharedSurface(guest))) {
    return;
  }

  useUIStore.getState().openContextSurface(dir, pluginModeFromId(id));
}
