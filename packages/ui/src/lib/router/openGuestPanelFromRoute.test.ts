import { afterEach, describe, expect, spyOn, test } from 'bun:test';

import { getRuntimeKey } from '@/lib/runtime-switch';
import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';
import { useGuestsStore } from '@/lib/guests/store';

import { openGuestPanelFromRoute } from './openGuestPanelFromRoute';

const DIRECTORY = '/projects/browser-help';

const catalogJson = (guests: unknown[]) => Response.json({ guests });

type FixtureGuestOverrides = {
  enabled?: boolean;
  capabilities?: { requested: string[]; granted: string[] };
};

const activeGuest = (overrides: FixtureGuestOverrides = {}) => ({
  id: 'server-chrome',
  name: 'Server Chrome',
  icon: 'window',
  entry: 'panel/index.html',
  capabilities: { requested: [], granted: [] },
  enabled: true,
  ...overrides,
});

afterEach(() => {
  useGuestsStore.getState().resetForRuntimeSwitch(getRuntimeKey());
});

describe('openGuestPanelFromRoute', () => {
  test('opens the context-panel surface for an enabled, approved guest', async () => {
    useGuestsStore.getState().resetForRuntimeSwitch(getRuntimeKey());
    const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(catalogJson([activeGuest()]));
    try {
      await openGuestPanelFromRoute(DIRECTORY, 'server-chrome');

      const directoryKey = normalizeContextPanelDirectoryKey(DIRECTORY);
      const panelState = useUIStore.getState().contextPanelByDirectory[directoryKey];
      const activeTab = panelState?.tabs.find((tab) => tab.id === panelState.activeTabId);
      expect(panelState?.isOpen).toBe(true);
      expect(activeTab?.mode).toBe('plugin:server-chrome');
    } finally {
      fetch.mockRestore();
    }
  });

  test('ignores an unknown guest id silently', async () => {
    useGuestsStore.getState().resetForRuntimeSwitch(getRuntimeKey());
    const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(catalogJson([activeGuest()]));
    try {
      const directoryKey = normalizeContextPanelDirectoryKey(DIRECTORY);
      const before = useUIStore.getState().contextPanelByDirectory[directoryKey];

      await openGuestPanelFromRoute(DIRECTORY, 'no-such-guest');

      expect(useUIStore.getState().contextPanelByDirectory[directoryKey]).toBe(before);
    } finally {
      fetch.mockRestore();
    }
  });

  test('ignores a disabled guest', async () => {
    useGuestsStore.getState().resetForRuntimeSwitch(getRuntimeKey());
    const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(catalogJson([activeGuest({ enabled: false })]));
    try {
      const directoryKey = normalizeContextPanelDirectoryKey(DIRECTORY);
      const before = useUIStore.getState().contextPanelByDirectory[directoryKey];

      await openGuestPanelFromRoute(DIRECTORY, 'server-chrome');

      expect(useUIStore.getState().contextPanelByDirectory[directoryKey]).toBe(before);
    } finally {
      fetch.mockRestore();
    }
  });

  test('ignores an unapproved guest', async () => {
    useGuestsStore.getState().resetForRuntimeSwitch(getRuntimeKey());
    const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(catalogJson([
      activeGuest({ capabilities: { requested: ['network'], granted: [] } }),
    ]));
    try {
      const directoryKey = normalizeContextPanelDirectoryKey(DIRECTORY);
      const before = useUIStore.getState().contextPanelByDirectory[directoryKey];

      await openGuestPanelFromRoute(DIRECTORY, 'server-chrome');

      expect(useUIStore.getState().contextPanelByDirectory[directoryKey]).toBe(before);
    } finally {
      fetch.mockRestore();
    }
  });

  test('does nothing for a blank guest id or directory', async () => {
    const fetch = spyOn(globalThis, 'fetch');
    try {
      await openGuestPanelFromRoute(DIRECTORY, '');
      await openGuestPanelFromRoute('', 'server-chrome');
      expect(fetch.mock.calls.length).toBe(0);
    } finally {
      fetch.mockRestore();
    }
  });
});
