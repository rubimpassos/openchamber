import { create } from 'zustand';

import {
  GUEST_REQUEST_TIMEOUT_MS,
  guestPlanName,
  isGuestPlanPathOf,
  type GuestPlanAnnotation,
  type GuestPlanProgress,
  type GuestPlanProviderContribution,
  type GuestPlanStatus,
} from '@openchamber/sdk';

import { getRuntimeKey } from '@/lib/runtime-switch';
import { isGuestActive } from '../capabilities';
import { useGuestsStore } from '../store';
import type { InstalledGuest } from '../types';
import { listGuestPlanFiles, type GuestPlanErrorCode } from './api';
import { waitForGuestPlanAnnotator } from './frames';

/**
 * What the Plans area knows about one provider's plans in one worktree. The
 * file list comes from the server and is authoritative; the extension's
 * description (title, progress, status, applicable actions) is laid over it
 * and may be missing without hiding a single file.
 */

export type GuestPlanTarget = {
  guestId: string;
  providerId: string;
  /** The worktree the plans are in. */
  directory: string;
};

export type GuestPlanEntry = {
  path: string;
  /** File name without extension; the title when the extension gave none. */
  name: string;
  title: string | null;
  progress: GuestPlanProgress | null;
  status: GuestPlanStatus | null;
  /** Declared action ids that apply now. Empty while the extension has not described the plan. */
  actions: string[];
  mtime: number;
};

/** Whether the extension's description of the listed plans arrived. */
export type GuestPlanDescription =
  | { state: 'loading' }
  | { state: 'ready' }
  | { state: 'failed'; reason: 'timeout' | 'unavailable' | 'error'; message?: string };

export type GuestPlanCatalog =
  | { status: 'loading' }
  | {
      status: 'ready';
      plans: GuestPlanEntry[];
      truncated: boolean;
      description: GuestPlanDescription;
      /** A newer read is on its way; what is shown stays until it lands. */
      refreshing: boolean;
    }
  | { status: 'error'; code: GuestPlanErrorCode; message: string };

/**
 * Identity of a catalog: runtime, installed package, provider and worktree.
 * An answer that started under another identity is dropped.
 */
export const guestPlanCatalogKey = (guest: Pick<InstalledGuest, 'id' | 'storageId' | 'version'>, target: GuestPlanTarget): string => JSON.stringify([
  getRuntimeKey(), guest.id, guest.storageId ?? '', guest.version ?? '', target.providerId, target.directory,
]);

type CatalogState = {
  catalogs: Record<string, GuestPlanCatalog>;
};

export const useGuestPlanCatalogStore = create<CatalogState>(() => ({ catalogs: {} }));

const latestRequest = new Map<string, number>();
let requestCounter = 0;

const setCatalog = (key: string, catalog: GuestPlanCatalog): void => {
  useGuestPlanCatalogStore.setState((state) => ({ catalogs: { ...state.catalogs, [key]: catalog } }));
};

export const findGuestPlanProvider = (guest: InstalledGuest | null | undefined, providerId: string): GuestPlanProviderContribution | null => (
  guest?.plans?.find((provider) => provider.id === providerId) ?? null
);

const findActiveGuest = (guestId: string): InstalledGuest | null => {
  const guest = useGuestsStore.getState().guests.find((entry) => entry.id === guestId) ?? null;
  return guest && isGuestActive(guest) ? guest : null;
};

const applyAnnotations = (
  provider: GuestPlanProviderContribution,
  plans: GuestPlanEntry[],
  annotations: readonly GuestPlanAnnotation[],
): GuestPlanEntry[] => {
  const declared = new Set((provider.actions ?? []).map((action) => action.id));
  const byPath = new Map(annotations.map((annotation) => [annotation.path, annotation]));
  return plans.map((plan) => {
    const annotation = byPath.get(plan.path);
    if (!annotation) return { ...plan, title: null, progress: null, status: null, actions: [...declared] };
    return {
      ...plan,
      title: annotation.title ?? null,
      progress: annotation.progress ?? null,
      status: annotation.status ?? null,
      actions: annotation.actions ? annotation.actions.filter((id) => declared.has(id)) : [...declared],
    };
  });
};

/**
 * Read the provider's plans in the worktree again: the file list from the
 * server, then the extension's description of exactly those files. Each step
 * lands only while it is still the newest request for that identity, so a
 * slow answer for another worktree, package version or runtime never shows.
 */
export const refreshGuestPlanCatalog = async (target: GuestPlanTarget): Promise<void> => {
  const guest = findActiveGuest(target.guestId);
  const provider = findGuestPlanProvider(guest, target.providerId);
  if (!guest || !provider) return;
  const key = guestPlanCatalogKey(guest, target);
  requestCounter += 1;
  const request = requestCounter;
  latestRequest.set(key, request);
  const isCurrent = () => latestRequest.get(key) === request;

  const previous = useGuestPlanCatalogStore.getState().catalogs[key];
  if (previous?.status === 'ready') setCatalog(key, { ...previous, refreshing: true });
  else setCatalog(key, { status: 'loading' });

  const listing = await listGuestPlanFiles(target.guestId, target.providerId, target.directory);
  if (!isCurrent()) return;
  if (!listing.ok) {
    setCatalog(key, { status: 'error', code: listing.code, message: listing.message });
    return;
  }
  const previousByPath = new Map(previous?.status === 'ready' ? previous.plans.map((plan) => [plan.path, plan]) : []);
  // Files the server would not list for this provider never reach the screen.
  const plans: GuestPlanEntry[] = listing.result.plans
    .filter((file) => isGuestPlanPathOf(provider, file.path))
    .map((file) => {
      const known = previousByPath.get(file.path);
      return {
        path: file.path,
        name: guestPlanName(file.path),
        title: known?.title ?? null,
        progress: known?.progress ?? null,
        status: known?.status ?? null,
        actions: [],
        mtime: file.mtime,
      };
    });
  setCatalog(key, { status: 'ready', plans, truncated: listing.result.truncated, description: { state: 'loading' }, refreshing: false });

  const annotator = await waitForGuestPlanAnnotator(target.guestId, target.directory, GUEST_REQUEST_TIMEOUT_MS);
  if (!isCurrent()) return;
  const outcome = annotator
    ? await annotator({ provider: target.providerId, directory: target.directory, plans: plans.map((plan) => ({ path: plan.path })) })
    : { ok: false as const, reason: 'unavailable' as const };
  if (!isCurrent()) return;
  const current = useGuestPlanCatalogStore.getState().catalogs[key];
  if (current?.status !== 'ready') return;
  if (!outcome.ok) {
    setCatalog(key, {
      ...current,
      plans: current.plans.map((plan) => ({ ...plan, actions: [] })),
      description: outcome.reason === 'error'
        ? { state: 'failed', reason: 'error', message: outcome.message }
        : { state: 'failed', reason: outcome.reason },
    });
    return;
  }
  setCatalog(key, { ...current, plans: applyAnnotations(provider, current.plans, outcome.annotations), description: { state: 'ready' } });
};

const invalidationListeners = new Set<(guestId: string, providerId: string) => void>();

/** Listen for an extension saying a provider's plans changed. */
export const subscribeGuestPlanInvalidation = (listener: (guestId: string, providerId: string) => void): (() => void) => {
  invalidationListeners.add(listener);
  return () => invalidationListeners.delete(listener);
};

export const invalidateGuestPlans = (guestId: string, providerId: string): void => {
  for (const listener of invalidationListeners) listener(guestId, providerId);
};
