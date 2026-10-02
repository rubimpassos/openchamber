import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { I18nProvider } from '@/lib/i18n';

type GuestRequest = { method: string; path: string; query?: Record<string, string>; body?: string };
type ProxyResult =
  | { ok: true; result: { status: number; body: string } }
  | { ok: false; code: string; message: string };

let nextListProfilesResult: ProxyResult = { ok: true, result: { status: 200, body: JSON.stringify({ ok: true, profiles: [], state: {} }) } };

mock.module('@/lib/guests/service', () => ({
  proxyGuestServiceRequest: async (_guestId: string, request: GuestRequest): Promise<ProxyResult> => {
    if (request.path === '/profiles' && request.method === 'GET') return nextListProfilesResult;
    return { ok: true, result: { status: 200, body: '{}' } };
  },
}));

const { BrowserProfilesSection } = await import('./BrowserProfilesSection');

const PROFILE = {
  id: 'abc123',
  name: 'Work',
  projects: [],
  createdAt: 1,
  lastUsedAt: 1700000000000,
  version: 2,
  savedAt: 1700000000000,
  saved: true,
  savedBytes: 10,
  signingIn: false,
  chats: [],
};

describe('BrowserProfilesSection', () => {
  let windowInstance: Window;
  let host: HTMLDivElement;
  let root: Root;
  let globalDescriptors: Map<string, PropertyDescriptor | undefined>;
  const globalNames = ['window', 'document', 'HTMLElement', 'Element', 'Node', 'localStorage', 'sessionStorage', 'navigator', 'IS_REACT_ACT_ENVIRONMENT'];

  beforeEach(() => {
    windowInstance = new Window();
    globalDescriptors = new Map(globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      HTMLElement: windowInstance.HTMLElement,
      Element: windowInstance.Element,
      Node: windowInstance.Node,
      localStorage: windowInstance.localStorage,
      sessionStorage: windowInstance.sessionStorage,
      navigator: windowInstance.navigator,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    try {
      await act(async () => root.unmount());
    } finally {
      windowInstance.close();
      for (const [name, descriptor] of globalDescriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });

  const renderSection = async () => {
    await act(async () => root.render(
      <I18nProvider>
        <BrowserProfilesSection />
      </I18nProvider>,
    ));
    // Flushes the `listProfiles()` effect's microtask and the follow-up render.
    await act(async () => {});
  };

  test('explains that the extension is needed when the host proxy cannot reach it', async () => {
    nextListProfilesResult = { ok: false, code: 'NO_SERVICE', message: 'No service for this extension.' };
    await renderSection();
    expect(host.textContent).toContain('Profiles need the server browser');
  });

  test('shows the empty state once the extension answers with no profiles', async () => {
    nextListProfilesResult = { ok: true, result: { status: 200, body: JSON.stringify({ ok: true, profiles: [], state: {} }) } };
    await renderSection();
    expect(host.textContent).toContain('No profiles yet');
  });

  test('lists a profile with its saved count, last used time, and sign-in action', async () => {
    nextListProfilesResult = { ok: true, result: { status: 200, body: JSON.stringify({ ok: true, profiles: [PROFILE], state: {} }) } };
    await renderSection();
    expect(host.textContent).toContain('Work');
    expect(host.textContent).toContain('Saved 2×');
    expect(host.textContent).toContain('No chats browsing on a copy');
    expect(host.querySelector('[aria-label="Sign in to Work"]')).not.toBeNull();
  });
});
