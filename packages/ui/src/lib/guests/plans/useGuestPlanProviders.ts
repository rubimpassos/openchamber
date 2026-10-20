import React from 'react';

import type { GuestPlanProviderContribution } from '@openchamber/sdk';

import { guestNeedsApproval } from '../capabilities';
import { useGuestsStore, type GuestsStatus } from '../store';
import type { InstalledGuest } from '../types';
import {
  guestPlanCatalogKey,
  refreshGuestPlanCatalog,
  subscribeGuestPlanInvalidation,
  useGuestPlanCatalogStore,
  type GuestPlanCatalog,
} from './catalog';
import { useGuestPlanFrameStore } from './frames';

/** Plans of a provider are re-read this often while they are on screen; extensions can ask sooner through `plansChanged`. */
const PROVIDER_REFRESH_MS = 15_000;

/**
 * Why a provider shows no plans of its own: the extension is paused, waits
 * for approval, or it is active and its catalog says the rest.
 */
export type GuestPlanProviderState = 'active' | 'paused' | 'needs-approval';

export type GuestPlanProviderView = {
  guest: InstalledGuest;
  provider: GuestPlanProviderContribution;
  state: GuestPlanProviderState;
  /** Catalog identity while active; null otherwise. */
  key: string | null;
  catalog: GuestPlanCatalog | null;
};

type GuestPlanProvidersView = {
  /** The extension catalog itself: `unsupported` on VS Code and mobile, where no extension runs. */
  catalogStatus: GuestsStatus;
  providers: GuestPlanProviderView[];
};

const providerState = (guest: InstalledGuest): GuestPlanProviderState => {
  if (guest.enabled === false) return 'paused';
  if (guestNeedsApproval(guest)) return 'needs-approval';
  return 'active';
};

/**
 * Every installed extension's plan providers for one worktree, with their
 * catalogs. While `visible`, it keeps each active extension's describing
 * frame for that worktree and re-reads the catalogs: at once, every
 * `PROVIDER_REFRESH_MS`, and whenever the extension says they changed.
 */
export const useGuestPlanProviders = (directory: string | null, visible: boolean): GuestPlanProvidersView => {
  const guests = useGuestsStore((state) => state.guests);
  const catalogStatus = useGuestsStore((state) => state.status);
  const catalogs = useGuestPlanCatalogStore((state) => state.catalogs);

  const providers = React.useMemo<GuestPlanProviderView[]>(() => {
    if (!directory) return [];
    return guests.flatMap((guest) => (guest.plans ?? []).map((provider) => {
      const state = providerState(guest);
      const key = state === 'active' ? guestPlanCatalogKey(guest, { guestId: guest.id, providerId: provider.id, directory }) : null;
      return { guest, provider, state, key, catalog: key ? catalogs[key] ?? null : null };
    }));
  }, [catalogs, directory, guests]);

  // Primitive identity of what has to be kept fresh, so a catalog update does not restart the effect.
  const activeSignature = React.useMemo(() => JSON.stringify(
    providers.filter((view) => view.key).map((view) => [view.guest.id, view.provider.id, view.key]),
  ), [providers]);

  React.useEffect(() => {
    if (!visible || !directory) return;
    const active: Array<[string, string, string]> = JSON.parse(activeSignature);
    if (active.length === 0) return;
    const hold = useGuestPlanFrameStore.getState().hold;
    const releases = [...new Set(active.map(([guestId]) => guestId))].map((guestId) => hold(guestId, directory));
    const refreshAll = () => {
      for (const [guestId, providerId] of active) void refreshGuestPlanCatalog({ guestId, providerId, directory });
    };
    refreshAll();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') refreshAll();
    }, PROVIDER_REFRESH_MS);
    const unsubscribe = subscribeGuestPlanInvalidation((guestId, providerId) => {
      if (active.some(([activeGuest, activeProvider]) => activeGuest === guestId && activeProvider === providerId)) {
        void refreshGuestPlanCatalog({ guestId, providerId, directory });
      }
    });
    return () => {
      window.clearInterval(timer);
      unsubscribe();
      for (const release of releases) release();
    };
  }, [activeSignature, directory, visible]);

  return { catalogStatus, providers };
};
