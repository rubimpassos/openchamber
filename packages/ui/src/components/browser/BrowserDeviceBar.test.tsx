import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { I18nProvider } from '@/lib/i18n';
import { FILL_VIEWPORT, VIEWPORT_PRESETS, presetViewport, type BrowserViewport } from '@/lib/browser/viewport';

import { BrowserDeviceBar } from './BrowserDeviceBar';

type Device = { readonly width: number; readonly height: number; readonly touch: boolean };

const PHONE: Device = { width: 390, height: 844, touch: true };
const DESKTOP: Device = { width: 1440, height: 900, touch: false };

type Page = {
  readonly host: HTMLElement;
  readonly applied: BrowserViewport[];
  readonly close: () => Promise<void>;
};

// The device is the one the app runs on: its window size and pointer. The page
// shown inside the browser panel has a viewport of its own, set by `initial`.
const openDeviceBar = async (device: Device, initial: BrowserViewport): Promise<Page> => {
  const dom = new Window({ url: 'http://localhost/', width: device.width, height: device.height });
  Object.defineProperty(dom, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: device.touch && (query === '(pointer: coarse)' || query === '(hover: none)'),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node, ResizeObserver: dom.ResizeObserver,
    MutationObserver: dom.MutationObserver, getComputedStyle: dom.getComputedStyle.bind(dom),
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    Event: dom.Event, CustomEvent: dom.CustomEvent, KeyboardEvent: dom.KeyboardEvent, MouseEvent: dom.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const descriptors = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const { createRoot } = await import('react-dom/client');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const applied: BrowserViewport[] = [];
  const Bar: React.FC = () => {
    const [viewport, setViewport] = React.useState(initial);
    return (
      <BrowserDeviceBar
        viewport={viewport}
        onViewportChange={(next) => { applied.push(next); setViewport(next); }}
        colorScheme="system"
        onColorSchemeChange={() => undefined}
        scale={1}
        panelSize={{ width: device.width, height: device.height }}
      />
    );
  };
  await act(async () => root.render(<I18nProvider><Bar /></I18nProvider>));
  return {
    host,
    applied,
    close: async () => {
      await act(async () => root.unmount());
      await dom.happyDOM.close();
      for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
};

const find = <T extends HTMLElement>(scope: ParentNode, selector: string): T => {
  const element = scope.querySelector<T>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
};

const tap = (target: HTMLElement) => act(async () => {
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
});

const presetSheet = () => document.querySelector<HTMLElement>('#mobile-overlay-root [role="dialog"][aria-label="Device preset"]');

// The sheet's own Close button is the only one it labels; every other button is a preset row.
const presetRows = (sheet: HTMLElement) => [...sheet.querySelectorAll<HTMLButtonElement>('button:not([aria-label])')];

const openPresetSheet = async (page: Page): Promise<HTMLElement> => {
  await tap(find<HTMLButtonElement>(page.host, 'button[aria-label="Device preset"]'));
  const sheet = presetSheet();
  if (!sheet) throw new Error('The device preset sheet did not open');
  return sheet;
};

const chooseRow = async (sheet: HTMLElement, name: string) => {
  const row = presetRows(sheet).find((candidate) => candidate.textContent === name);
  if (!row) throw new Error(`No preset row named ${name}`);
  await tap(row);
};

test('on a phone the device preset is picked from a sheet that lists every preset and applies the tapped one', async () => {
  const start = presetViewport('iphone-14');
  const next = presetViewport('iphone-14-pro-max');
  if (!start || !next) throw new Error('The presets this test picks are gone');
  const page = await openDeviceBar(PHONE, start);
  try {
    const trigger = find<HTMLButtonElement>(page.host, 'button[aria-label="Device preset"]');
    expect(trigger.textContent).toBe('iPhone 14');
    const description = trigger.getAttribute('aria-describedby');
    if (!description) throw new Error('The preset trigger must describe its current value');
    expect(document.getElementById(description)?.textContent).toBe('iPhone 14');
    expect(presetSheet()).toBeNull();

    const sheet = await openPresetSheet(page);
    expect(page.host.querySelector('[role="listbox"]')).toBeNull();
    expect(document.querySelector('[data-slot="select-content"]')).toBeNull();
    expect(presetRows(sheet).map((row) => row.textContent)).toEqual(['Responsive', ...VIEWPORT_PRESETS.map((preset) => preset.label)]);
    expect(presetRows(sheet).filter((row) => row.getAttribute('aria-current') === 'true').map((row) => row.textContent)).toEqual(['iPhone 14']);

    await chooseRow(sheet, 'iPhone 14 Pro Max');
    expect(page.applied).toEqual([next]);
    expect(presetSheet()).toBeNull();
    expect(trigger.textContent).toBe('iPhone 14 Pro Max');
    expect(document.getElementById(description)?.textContent).toBe('iPhone 14 Pro Max');

    const reopened = await openPresetSheet(page);
    expect(presetRows(reopened).filter((row) => row.getAttribute('aria-current') === 'true').map((row) => row.textContent)).toEqual(['iPhone 14 Pro Max']);
    await chooseRow(reopened, 'Responsive');
    expect(page.applied).toEqual([next, FILL_VIEWPORT]);
    expect(presetSheet()).toBeNull();
    expect(trigger.textContent).toBe('Responsive');
  } finally {
    await page.close();
  }
});

test('a desktop window showing a phone-sized page keeps the dropdown picker', async () => {
  const phonePage = presetViewport('iphone-14');
  if (!phonePage) throw new Error('The preset this test shows is gone');
  const page = await openDeviceBar(DESKTOP, phonePage);
  try {
    const trigger = find<HTMLElement>(page.host, '[data-slot="select-trigger"][aria-label="Device preset"]');
    expect(trigger.getAttribute('role')).toBe('combobox');
    expect(trigger.textContent).toBe('iPhone 14');

    await tap(trigger);
    expect(presetSheet()).toBeNull();
    expect(page.applied).toEqual([]);
  } finally {
    await page.close();
  }
});
