import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/', width: 1280, height: 800 });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement, Event: browser.Event,
  getComputedStyle: browser.getComputedStyle.bind(browser), matchMedia: browser.matchMedia.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
});
// React DOM reads the DOM when imported, so it goes in first.
const { createRoot } = await import('react-dom/client');
const { Dialog, DialogContent } = await import('./dialog');
const { I18nProvider } = await import('@/lib/i18n');

let reactRoot: Root | null = null;

const draw = async (dialog: React.ReactNode) => {
  reactRoot ??= createRoot(document.body.appendChild(document.createElement('div')));
  await act(async () => reactRoot?.render(<I18nProvider>{dialog}</I18nProvider>));
  return document.querySelector('[data-slot="dialog-content"]');
};
const popupFor = (fullWindow: boolean) => draw(
  <Dialog open>
    <DialogContent fullWindow={fullWindow} aria-label="Window">Body</DialogContent>
  </Dialog>,
);
const stagedDialog = (open: boolean) => (
  <Dialog open={open}>
    <DialogContent staged={!open} aria-label="Window"><iframe title="Page" /></DialogContent>
  </Dialog>
);
const marksOpenDialog = () => document.documentElement.classList.contains('oc-dialog-open');

const clear = async () => {
  await act(async () => reactRoot?.unmount());
  reactRoot = null;
  document.body.innerHTML = '';
};

afterEach(clear);

describe('DialogContent', () => {
  test('a dialog takes the installed-app inset and window corners, and a full-window one leaves both out', async () => {
    const docked = await popupFor(false);
    expect(docked?.classList.contains('pwa-dialog-content')).toBe(true);
    expect(docked?.classList.contains('oc-window-corners')).toBe(true);
    await clear();
    const full = await popupFor(true);
    expect(full?.classList.contains('pwa-dialog-content')).toBe(false);
    expect(full?.classList.contains('oc-window-corners')).toBe(false);
  });

  test('a staged dialog is laid out for measuring without being an open dialog, and opens on the same nodes', async () => {
    // Given a closed dialog whose owner stages its content to measure it.
    const staged = await draw(stagedDialog(false));
    const frame = staged?.querySelector('iframe');

    // Then the popup is in the layout, out of reach, and nothing treats it as an open dialog.
    expect(frame?.title).toBe('Page');
    expect(staged?.hasAttribute('hidden')).toBe(false);
    expect(staged?.hasAttribute('inert')).toBe(true);
    expect(staged?.getAttribute('aria-hidden')).toBe('true');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector('[data-slot="dialog-overlay"]')).toBeNull();
    expect(marksOpenDialog()).toBe(false);

    // When the owner opens it.
    const opened = await draw(stagedDialog(true));

    // Then the staged popup and its frame are the open dialog, with its backdrop.
    expect(opened === staged).toBe(true);
    expect(opened?.querySelector('iframe') === frame).toBe(true);
    expect(opened?.getAttribute('role')).toBe('dialog');
    expect(opened?.hasAttribute('inert')).toBe(false);
    expect(opened?.hasAttribute('aria-hidden')).toBe(false);
    expect(document.querySelector('[data-slot="dialog-overlay"]')).not.toBeNull();
    expect(marksOpenDialog()).toBe(true);
  });
});
