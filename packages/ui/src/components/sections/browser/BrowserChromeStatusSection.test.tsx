import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { I18nProvider } from '@/lib/i18n';

type GuestRequest = { method: string; path: string };
type ProxyResult =
  | { ok: true; result: { status: number; body: string } }
  | { ok: false; code: string; message: string };

let nextChromeResult: ProxyResult = { ok: true, result: { status: 200, body: JSON.stringify({ status: 'ready', message: '' }) } };

mock.module('@/lib/guests/service', () => ({
  proxyGuestServiceRequest: async (_guestId: string, request: GuestRequest): Promise<ProxyResult> => {
    if (request.path === '/chrome') return nextChromeResult;
    return { ok: true, result: { status: 200, body: '{}' } };
  },
}));

const { BrowserChromeStatusSection } = await import('./BrowserChromeStatusSection');

describe('BrowserChromeStatusSection', () => {
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
        <BrowserChromeStatusSection />
      </I18nProvider>,
    ));
    await act(async () => {});
  };

  test('renders nothing when the host proxy cannot reach the extension', async () => {
    nextChromeResult = { ok: false, code: 'NO_SERVICE', message: 'No service for this extension.' };
    await renderSection();
    expect(host.textContent).toBe('');
  });

  test('shows Ready with the detected path and version', async () => {
    nextChromeResult = { ok: true, result: { status: 200, body: JSON.stringify({ status: 'ready', message: '', path: '/opt/chrome/chrome', version: '131.0.0.0' }) } };
    await renderSection();
    expect(host.textContent).toContain('Ready');
    expect(host.textContent).toContain('/opt/chrome/chrome');
    expect(host.textContent).toContain('131.0.0.0');
  });

  test('pulls the apt command out of a missing-libraries message for the Copy button', async () => {
    nextChromeResult = {
      ok: true,
      result: {
        status: 200,
        body: JSON.stringify({
          status: 'missing-libraries',
          message: 'Chrome is installed but this machine lacks libraries it needs (libnss3.so). Run this once on the server, then retry: sudo apt-get install -y libnss3',
        }),
      },
    };
    await renderSection();
    expect(host.textContent).toContain('Missing system libraries');
    expect(host.textContent).toContain('sudo apt-get install -y libnss3');
    expect(host.querySelector('button')).not.toBeNull();
  });
});
