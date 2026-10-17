import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { I18nProvider } from '@/lib/i18n';
import type { I18nKey } from '@/lib/i18n/store';
import { buildSettingsSearchResults } from '@/lib/settings/search';
import { useUIStore } from '@/stores/useUIStore';

import { ChatSettings } from './ChatSettings';
import { chatSettingsTabForSearchTarget, useChatSettingsTabStore } from './chatSettingsTabs';

const runtimeCtx = {
  isVSCode: false,
  isWeb: true,
  isDesktop: false,
  isMobile: false,
  isDesktopLocalOrigin: false,
  isMac: false,
  isWindows: false,
  isLinux: false,
  routingAvailable: false,
  enterpriseMode: false,
  jevBlockedByEnterprise: false,
};

describe('ChatSettings', () => {
  let windowInstance: Window;
  let host: HTMLDivElement;
  let root: Root;
  let initialLargeTextPasteBehavior: ReturnType<typeof useUIStore.getState>['largeTextPasteBehavior'];
  let initialStickyUserHeader: boolean;
  let globalDescriptors: Map<string, PropertyDescriptor | undefined>;

  // The tab strip measures itself, so it needs ResizeObserver too.
  const globalNames = ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'ResizeObserver', 'localStorage', 'sessionStorage', 'IS_REACT_ACT_ENVIRONMENT'];

  beforeEach(() => {
    windowInstance = new Window();
    initialLargeTextPasteBehavior = useUIStore.getState().largeTextPasteBehavior;
    initialStickyUserHeader = useUIStore.getState().stickyUserHeader;
    globalDescriptors = new Map(globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      HTMLElement: windowInstance.HTMLElement,
      Element: windowInstance.Element,
      Node: windowInstance.Node,
      ResizeObserver: windowInstance.ResizeObserver,
      localStorage: windowInstance.localStorage,
      sessionStorage: windowInstance.sessionStorage,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: windowInstance.navigator });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    try {
      await act(async () => root.unmount());
    } finally {
      useUIStore.setState({ largeTextPasteBehavior: initialLargeTextPasteBehavior, stickyUserHeader: initialStickyUserHeader });
      useChatSettingsTabStore.setState({ tab: 'messages' });
      windowInstance.close();
      for (const [name, descriptor] of globalDescriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });

  test('the large-paste radios on the Composer tab select the fourth persisted choice', async () => {
    useChatSettingsTabStore.setState({ tab: 'composer' });
    await act(async () => root.render(
      <I18nProvider>
        <ChatSettings />
      </I18nProvider>,
    ));
    const group = host.querySelector('[data-settings-item="chat.large-text-paste"]');
    expect(group).not.toBeNull();
    const radios = group?.querySelectorAll<HTMLElement>('[role="radio"]');
    expect(radios?.length).toBe(4);
    const fourth = radios?.[3];
    if (!fourth) throw new Error('Missing fourth paste choice');
    expect(fourth.getAttribute('aria-label')).toBe('Large text paste: Paste inline, double-paste to attach');
    await act(async () => fourth.click());
    expect(useUIStore.getState().largeTextPasteBehavior).toBe('inline-double-paste');
    expect(fourth.getAttribute('aria-checked')).toBe('true');
  });

  test('the Messages tab shows the stored sticky-header choice on phones', async () => {
    Object.defineProperty(windowInstance, 'innerWidth', { configurable: true, value: 390 });
    Object.defineProperty(windowInstance.navigator, 'maxTouchPoints', { configurable: true, value: 1 });
    useUIStore.setState({ stickyUserHeader: true });

    await act(async () => root.render(
      <I18nProvider>
        <ChatSettings />
      </I18nProvider>,
    ));

    const control = host.querySelector('[data-settings-item="chat.sticky-user-header"] [role="checkbox"]');
    expect(control?.getAttribute('aria-checked')).toBe('true');
  });

  test('the phone-only sticky-header choice stays hidden on desktop', async () => {
    await act(async () => root.render(
      <I18nProvider>
        <ChatSettings />
      </I18nProvider>,
    ));

    expect(host.querySelector('[data-settings-item="chat.sticky-user-header"]')).toBeNull();
  });

  test('every desktop and mobile Chat search result opens the tab that holds it', () => {
    const t = (key: I18nKey): string => key;
    for (const context of [runtimeCtx, { ...runtimeCtx, isMobile: true }]) {
      const results = buildSettingsSearchResults({ query: 'chat-page', runtimeCtx: context, t, getPageTitle: (page) => `${page}-page` })
        .filter((result) => result.page === 'chat');
      expect(results.length).toBeGreaterThan(20);
      for (const result of results) {
        expect({ id: result.id, tab: chatSettingsTabForSearchTarget(result.id) }).not.toEqual({ id: result.id, tab: null });
      }
    }
  });
});
