import { afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { I18nProvider } from '@/lib/i18n';
import { useI18nStore, formatMessage } from '@/lib/i18n/store';
import { dict as en } from '@/lib/i18n/messages/en';
import { dict as ptBR } from '@/lib/i18n/messages/pt-BR';
import type { InstalledGuest } from '@/lib/guests/types';

const guest: InstalledGuest = {
  id: 'local-api', name: 'Local API', icon: 'plug', source: 'path', version: '1.0.0',
  capabilities: { requested: ['loopback'], granted: [] },
  loopback: { port: 8123, env: 'OC_TEST_PORT', status: 'ready', resolvedPort: 9123, routes: [
    { path: '/state', methods: ['GET', 'HEAD'] }, { path: '/sessions/*', methods: ['POST'] },
  ] },
};
let dom: Window;
let root: Root;
const globals = new Map<string, PropertyDescriptor | undefined>();
const originalI18n = useI18nStore.getState();
beforeEach(() => {
  dom = new Window({ url: 'http://localhost/' });
  const values = {
    window: dom, document: dom.document, navigator: dom.navigator,
    HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node,
    DocumentFragment: dom.DocumentFragment, MutationObserver: dom.MutationObserver,
    ResizeObserver: dom.ResizeObserver, MouseEvent: dom.MouseEvent, Event: dom.Event,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [key, value] of Object.entries(values)) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  useI18nStore.setState(originalI18n);
  await dom.happyDOM.close();
  for (const [key, value] of globals) {
    if (value) Object.defineProperty(globalThis, key, value);
    else Reflect.deleteProperty(globalThis, key);
  }
  globals.clear();
});

const render = async (value: InstalledGuest) => {
  // Base UI detects DOM availability at module initialization, before portals mount.
  const { GuestApprovalDialog } = await import('./GuestApprovalDialog');
  await act(async () => { root.render(
    <I18nProvider><GuestApprovalDialog guest={value} busy={false} onApprove={() => {}} onDecline={() => {}} onDismiss={() => {}} /></I18nProvider>,
  ); });
};

for (const { locale, dictionary } of [{ locale: 'en', dictionary: en }, { locale: 'pt-BR', dictionary: ptBR }] as const) {
  test(`shows the actual target and localized scope when the locale is ${locale}`, async () => {
    // Given a resolved port different from the fallback and an active locale.
    useI18nStore.setState({ locale, dictionary });
    // When opening the real approval component.
    await render(guest);
    // Then it displays the actual server destination and every allowed method/path.
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain(formatMessage(dictionary, 'settings.extensions.capability.loopback.target', { target: '127.0.0.1:9123' }));
    expect(dialog?.textContent).toContain(formatMessage(dictionary, 'settings.extensions.capability.loopback.environment', { env: 'OC_TEST_PORT', port: 8123 }));
    const routes = dialog?.querySelector(`ul[aria-label="${dictionary['settings.extensions.capability.loopback.routes']}"]`);
    expect([...routes?.querySelectorAll('li') ?? []].map((row) => row.textContent)).toEqual(['GET /state', 'HEAD /state', 'POST /sessions/*']);
  });
}

test('prevents approval when the server port configuration is invalid', async () => {
  // Given a configuration failure with no resolved destination.
  useI18nStore.setState({ locale: 'en', dictionary: en });
  const invalid: InstalledGuest = { ...guest, loopback: { port: 8123, env: 'OC_TEST_PORT', routes: [{ path: '/state', methods: ['GET'] }], status: 'config-invalid' } };
  // When opening the approval component.
  await render(invalid);
  // Then the error is accessible and approval is disabled, but declining stays available.
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(en['settings.extensions.capability.loopback.invalid']);
  const buttons = [...document.querySelectorAll('button')];
  expect(buttons.find((button) => button.textContent === en['settings.extensions.dialog.approve'])?.disabled).toBe(true);
  expect(buttons.find((button) => button.textContent === en['settings.extensions.dialog.decline'])?.disabled).toBe(false);
});
