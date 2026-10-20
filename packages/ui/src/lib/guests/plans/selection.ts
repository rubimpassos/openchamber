import { z } from 'zod';

import { matchesRankQuery } from '@/lib/search/fuzzySearch';
import type { GuestPlanEntry, GuestPlanTarget } from './catalog';
import type { GuestPlanProviderView } from './useGuestPlanProviders';

/** One extension plan: which extension, provider and worktree, and its path there. */
export type ExtensionPlanSelection = GuestPlanTarget & { path: string };

const ENTRY_PREFIX = 'extension-plan:';
const entrySchema = z.tuple([z.string().min(1), z.string().min(1), z.string().min(1), z.string().min(1)]);

/** The Plans panel's entry id for an extension plan; never collides with a saved plan id. */
export const extensionPlanEntryId = (selection: ExtensionPlanSelection): string => (
  `${ENTRY_PREFIX}${JSON.stringify([selection.guestId, selection.providerId, selection.directory, selection.path])}`
);

export const parseExtensionPlanEntryId = (id: string): ExtensionPlanSelection | null => {
  if (!id.startsWith(ENTRY_PREFIX)) return null;
  let json: unknown;
  try {
    json = JSON.parse(id.slice(ENTRY_PREFIX.length));
  } catch {
    return null;
  }
  const parsed = entrySchema.safeParse(json);
  if (!parsed.success) return null;
  const [guestId, providerId, directory, path] = parsed.data;
  return { guestId, providerId, directory, path };
};

/** Plans of a provider that match the panel's search, by title, file name and path. */
export const visibleExtensionPlans = (view: GuestPlanProviderView, query: string): GuestPlanEntry[] => (
  view.catalog?.status === 'ready'
    ? view.catalog.plans.filter((plan) => matchesRankQuery([plan.title ?? '', plan.name, plan.path], query))
    : []
);
