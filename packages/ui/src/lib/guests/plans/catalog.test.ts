import { afterEach, describe, expect, spyOn, test } from 'bun:test';

import type { GuestPlanProviderContribution } from '@openchamber/sdk';

import { getRuntimeKey } from '@/lib/runtime-switch';
import { useGuestsStore } from '../store';
import type { InstalledGuest } from '../types';
import { guestPlanCatalogKey, refreshGuestPlanCatalog, useGuestPlanCatalogStore } from './catalog';
import { registerGuestPlanAnnotator } from './frames';

const provider: GuestPlanProviderContribution = {
  id: 'shelf',
  label: 'Shelf',
  root: 'plans',
  actions: [
    { id: 'run', kind: 'execute', label: 'Run', run: { type: 'command', name: 'shelf-run', arguments: '{plan.name}' } },
    { id: 'review', kind: 'review', label: 'Review', run: { type: 'prompt', text: 'Review {plan.path}' } },
  ],
};

const guest: InstalledGuest = {
  id: 'plan-shelf',
  name: 'Plan Shelf',
  icon: 'file-list-2',
  backgroundEntry: 'index.html',
  version: '1.0.0',
  storageId: '00000000-0000-4000-8000-000000000001',
  plans: [provider],
  enabled: true,
  capabilities: { requested: ['plans'], granted: ['plans'] },
};

const listing = (paths: string[]) => Response.json({ ok: true, result: { plans: paths.map((path) => ({ path, size: 1, mtime: 1 })), truncated: false } });

const releases: Array<() => void> = [];
afterEach(() => {
  for (const release of releases.splice(0)) release();
  useGuestPlanCatalogStore.setState({ catalogs: {} });
  useGuestsStore.getState().resetForRuntimeSwitch(getRuntimeKey());
});

const install = (entry: InstalledGuest = guest) => {
  if (useGuestsStore.getState().runtimeKey !== getRuntimeKey()) useGuestsStore.getState().resetForRuntimeSwitch(getRuntimeKey());
  useGuestsStore.getState().replaceCatalog([entry], getRuntimeKey());
};
const catalogFor = (directory: string) => (
  useGuestPlanCatalogStore.getState().catalogs[guestPlanCatalogKey(guest, { guestId: guest.id, providerId: 'shelf', directory })]
);
const headerDirectory = (init: RequestInit | undefined): string => new Headers(init?.headers).get('x-opencode-directory') ?? '';

describe('extension plan catalogs', () => {
  test('lists every file and lays the extension description over them, per worktree', async () => {
    install();
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => (
      headerDirectory(init) === '/repo/one' ? listing(['plans/auth.md', 'plans/new.md']) : listing(['plans/auth.md'])
    ));
    releases.push(registerGuestPlanAnnotator(guest.id, '/repo/one', async () => ({
      ok: true,
      annotations: [
        { path: 'plans/auth.md', title: 'Auth in one', progress: { done: 1, total: 3 }, actions: ['run', 'unknown'] },
        { path: 'plans/not-listed.md', title: 'Ignored' },
      ],
    })));
    releases.push(registerGuestPlanAnnotator(guest.id, '/repo/two', async () => ({
      ok: true,
      annotations: [{ path: 'plans/auth.md', title: 'Auth in two' }],
    })));
    try {
      await refreshGuestPlanCatalog({ guestId: guest.id, providerId: 'shelf', directory: '/repo/one' });
      await refreshGuestPlanCatalog({ guestId: guest.id, providerId: 'shelf', directory: '/repo/two' });
    } finally {
      fetch.mockRestore();
    }
    const one = catalogFor("/repo/one");
    const two = catalogFor('/repo/two');
    expect(one?.status === 'ready' && one.plans).toEqual([
      { path: 'plans/auth.md', name: 'auth', title: 'Auth in one', progress: { done: 1, total: 3 }, status: null, actions: ['run'], mtime: 1 },
      // Never run, never described: listed by its file name, every declared action applies.
      { path: 'plans/new.md', name: 'new', title: null, progress: null, status: null, actions: ['run', 'review'], mtime: 1 },
    ]);
    expect(two?.status === 'ready' && two.plans.map((plan) => plan.title)).toEqual(['Auth in two']);
  });

  test('a slower earlier read never replaces a newer one', async () => {
    install();
    let releaseSlow: (response: Response) => void = () => {};
    let call = 0;
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(() => {
      call += 1;
      if (call === 1) return new Promise<Response>((resolve) => { releaseSlow = resolve; });
      return Promise.resolve(listing(['plans/fresh.md']));
    });
    releases.push(registerGuestPlanAnnotator(guest.id, '/repo/one', async () => ({ ok: true, annotations: [] })));
    try {
      const slow = refreshGuestPlanCatalog({ guestId: guest.id, providerId: 'shelf', directory: '/repo/one' });
      await refreshGuestPlanCatalog({ guestId: guest.id, providerId: 'shelf', directory: '/repo/one' });
      releaseSlow(listing(['plans/stale.md']));
      await slow;
    } finally {
      fetch.mockRestore();
    }
    const catalog = catalogFor('/repo/one');
    expect(catalog?.status === 'ready' && catalog.plans.map((plan) => plan.path)).toEqual(['plans/fresh.md']);
  });

  test('an extension that cannot describe its plans leaves them listed without actions', async () => {
    install();
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(async () => listing(['plans/auth.md']));
    releases.push(registerGuestPlanAnnotator(guest.id, '/repo/one', async () => ({ ok: false, reason: 'error', message: 'state file is corrupt' })));
    try {
      await refreshGuestPlanCatalog({ guestId: guest.id, providerId: 'shelf', directory: '/repo/one' });
    } finally {
      fetch.mockRestore();
    }
    const catalog = catalogFor('/repo/one');
    expect(catalog?.status === 'ready' && catalog.plans.map((plan) => [plan.path, plan.actions])).toEqual([['plans/auth.md', []]]);
    expect(catalog?.status === 'ready' && catalog.description).toEqual({ state: 'failed', reason: 'error', message: 'state file is corrupt' });
  });

  test('a failed listing is an error, never an empty list, and a paused extension is not asked', async () => {
    install();
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ error: 'BAD_PATH', message: 'The plan folder leaves the worktree.' }, { status: 400 }));
    try {
      await refreshGuestPlanCatalog({ guestId: guest.id, providerId: 'shelf', directory: '/repo/one' });
      expect(catalogFor('/repo/one')).toEqual({ status: 'error', code: 'BAD_PATH', message: 'The plan folder leaves the worktree.' });
      install({ ...guest, enabled: false });
      const callsBefore = fetch.mock.calls.length;
      await refreshGuestPlanCatalog({ guestId: guest.id, providerId: 'shelf', directory: '/repo/one' });
      expect(fetch.mock.calls.length).toBe(callsBefore);
    } finally {
      fetch.mockRestore();
    }
  });
});
