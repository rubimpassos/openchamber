import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { SurfaceInputEvent } from '@openchamber/sdk';

import { I18nProvider } from '@/lib/i18n';
import type { BrowserViewport } from '@/lib/browser/viewport';

import { BrowserDeviceBar } from './BrowserDeviceBar';
import { BrowserToolbar } from './BrowserToolbar';
import { RemoteTypingField } from './RemoteTypingField';

type Page = {
  readonly dom: Window;
  readonly host: HTMLElement;
  readonly render: (node: React.ReactNode) => Promise<void>;
  readonly close: () => Promise<void>;
};

const openPage = async (): Promise<Page> => {
  const dom = new Window({ url: 'http://localhost/' });
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node, ResizeObserver: dom.ResizeObserver,
    MutationObserver: dom.MutationObserver, getComputedStyle: dom.getComputedStyle.bind(dom),
    Event: dom.Event, KeyboardEvent: dom.KeyboardEvent, MouseEvent: dom.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const descriptors = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const { createRoot } = await import('react-dom/client');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  return {
    dom,
    host,
    render: (node) => act(async () => root.render(<I18nProvider>{node}</I18nProvider>)),
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

const find = <T extends HTMLElement>(host: HTMLElement, selector: string): T => {
  const element = host.querySelector<T>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
};

const typeInto = async (page: Page, field: HTMLInputElement | HTMLTextAreaElement, text: string) => {
  const prototype = field.tagName === 'TEXTAREA' ? page.dom.HTMLTextAreaElement.prototype : page.dom.HTMLInputElement.prototype;
  const setValue = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (!setValue) throw new Error('The field has no value setter');
  await act(async () => {
    setValue.call(field, text);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const press = (target: HTMLElement, key: string, type: 'keydown' | 'keyup' = 'keydown') => act(async () => {
  target.dispatchEvent(new KeyboardEvent(type, { key, code: key, bubbles: true, cancelable: true }));
});

const dispatch = async (target: HTMLElement, type: string) => {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true });
  await act(async () => { target.dispatchEvent(event); });
  return event;
};

const NO_ACTION = () => undefined;

const AddressBar: React.FC<{ onSubmit: (value: string) => void; suggestions?: string[] }> = ({ onSubmit, suggestions = [] }) => {
  const [address, setAddress] = React.useState('https://example.com/start');
  return (
    <BrowserToolbar
      address={address}
      onAddressChange={setAddress}
      onSubmit={onSubmit}
      suggestions={suggestions.map((url) => ({ url, title: '', lastVisitedAt: 1 }))}
      onBack={NO_ACTION}
      onForward={NO_ACTION}
      onReload={NO_ACTION}
      onOpenExternal={NO_ACTION}
      canGoBack={false}
      canGoForward={false}
      isLoading={false}
    />
  );
};

test('the address bar takes typed text and goes there on the keyboard\'s Go key', async () => {
  const page = await openPage();
  const submitted: string[] = [];
  try {
    await page.render(<AddressBar onSubmit={(value) => submitted.push(value)} />);
    const address = find<HTMLInputElement>(page.host, 'input[aria-label="Browser address"]');
    expect(address.getAttribute('enterkeyhint')).toBe('go');
    expect(address.getAttribute('inputmode')).toBe('url');

    await act(async () => address.focus());
    expect(document.activeElement === address).toBe(true);
    await typeInto(page, address, 'localhost:3000/login');
    expect(address.value).toBe('localhost:3000/login');
    await press(address, 'Enter');

    expect(submitted).toEqual(['localhost:3000/login']);
    expect(document.activeElement === address).toBe(false);
  } finally {
    await page.close();
  }
});

test('a finger landing on a suggestion keeps the address focused and opens it only on the tap', async () => {
  const page = await openPage();
  const submitted: string[] = [];
  try {
    await page.render(<AddressBar onSubmit={(value) => submitted.push(value)} suggestions={['https://example.com/docs']} />);
    const address = find<HTMLInputElement>(page.host, 'input[aria-label="Browser address"]');
    await act(async () => address.focus());
    const option = find<HTMLElement>(page.host, '[role="option"]');

    await dispatch(option, 'pointerdown');
    expect(submitted).toEqual([]);
    const mouseDown = await dispatch(option, 'mousedown');
    expect(mouseDown.defaultPrevented).toBe(true);
    await dispatch(option, 'click');

    expect(submitted).toEqual(['https://example.com/docs']);
  } finally {
    await page.close();
  }
});

test('history suggestions accept Ctrl+N and Ctrl+P alongside the arrow keys', async () => {
  const page = await openPage();
  const submitted: string[] = [];
  try {
    await page.render(<AddressBar onSubmit={(value) => submitted.push(value)} suggestions={['https://example.com/one', 'https://example.com/two']} />);
    const address = find<HTMLInputElement>(page.host, 'input[aria-label="Browser address"]');
    await act(async () => address.focus());
    await press(address, 'ArrowDown');
    for (const key of ['n', 'p']) {
      await act(async () => address.dispatchEvent(new KeyboardEvent('keydown', {
        key, code: key === 'n' ? 'KeyN' : 'KeyP', ctrlKey: true, bubbles: true, cancelable: true,
      })));
      expect(page.host.querySelectorAll('[role="option"]')[key === 'n' ? 1 : 0]?.getAttribute('aria-selected')).toBe('true');
    }
    await press(address, 'Enter');
    expect(submitted).toEqual(['https://example.com/one']);
  } finally {
    await page.close();
  }
});

test('accepting an IME candidate does not navigate to the highlighted history suggestion', async () => {
  const page = await openPage();
  const submitted: string[] = [];
  try {
    await page.render(<AddressBar onSubmit={(value) => submitted.push(value)} suggestions={['https://example.com/docs']} />);
    const address = find<HTMLInputElement>(page.host, 'input[aria-label="Browser address"]');
    await act(async () => address.focus());
    await press(address, 'ArrowDown');

    await act(async () => address.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', isComposing: true, bubbles: true, cancelable: true,
    })));

    expect(submitted).toEqual([]);
    expect(document.activeElement).toBe(address);
  } finally {
    await page.close();
  }
});

test('a custom size is applied when the keyboard moves on, never while its digits are typed', async () => {
  const page = await openPage();
  const applied: BrowserViewport[] = [];
  const Bar: React.FC = () => {
    const [viewport, setViewport] = React.useState<BrowserViewport>({ kind: 'fill' });
    return (
      <BrowserDeviceBar
        viewport={viewport}
        onViewportChange={(next) => { applied.push(next); setViewport(next); }}
        colorScheme="system"
        onColorSchemeChange={NO_ACTION}
        scale={1}
        panelSize={{ width: 390, height: 700 }}
      />
    );
  };
  try {
    await page.render(<Bar />);
    const width = find<HTMLInputElement>(page.host, 'input[aria-label="Viewport width"]');
    const height = find<HTMLInputElement>(page.host, 'input[aria-label="Viewport height"]');
    expect(width.getAttribute('enterkeyhint')).toBe('next');
    expect(height.getAttribute('enterkeyhint')).toBe('done');

    await act(async () => width.focus());
    await typeInto(page, width, '1');
    await typeInto(page, width, '1280');
    expect(applied).toEqual([]);
    expect(width.value).toBe('1280');

    await press(width, 'Enter');
    expect(document.activeElement === height).toBe(true);
    expect(applied).toEqual([{ kind: 'custom', width: 1280, height: 700 }]);

    await typeInto(page, height, '90');
    await typeInto(page, height, '900');
    await press(height, 'Enter');
    expect(document.activeElement === height).toBe(false);
    expect(applied).toEqual([{ kind: 'custom', width: 1280, height: 700 }, { kind: 'custom', width: 1280, height: 900 }]);
  } finally {
    await page.close();
  }
});

test('a key typed into the page is sent once: by the field\'s text, or as a key, never both', async () => {
  const page = await openPage();
  const typed: SurfaceInputEvent[] = [];
  const keys: string[] = [];
  const reachedPicture: string[] = [];
  const opened: boolean[] = [];
  try {
    await page.render(
      <div onKeyDown={(event) => reachedPicture.push(event.key)} onKeyUp={(event) => reachedPicture.push(event.key)}>
        <RemoteTypingField
          pageEpoch="loaded"
          onType={(events) => typed.push(...events)}
          onKey={(action, event) => { keys.push(`${action}:${event.key}`); event.preventDefault(); }}
          onOpenChange={(open) => opened.push(open)}
        />
      </div>,
    );
    const field = find<HTMLTextAreaElement>(page.host, 'textarea');
    await act(async () => field.focus());
    expect(opened).toEqual([true]);

    await press(field, 'h');
    await typeInto(page, field, 'h');
    await press(field, 'h', 'keyup');
    expect(typed).toEqual([{ type: 'text', text: 'h' }]);
    expect(keys).toEqual([]);

    await press(field, 'Backspace');
    await typeInto(page, field, '');
    await press(field, 'Backspace', 'keyup');
    expect(typed.filter((event) => event.type === 'key' && event.action === 'down').length).toBe(1);
    expect(keys).toEqual([]);

    await press(field, 'Backspace');
    await press(field, 'Backspace', 'keyup');
    expect(keys).toEqual(['down:Backspace', 'up:Backspace']);

    await typeInto(page, field, 'ok');
    await press(field, 'Enter');
    expect(keys).toEqual(['down:Backspace', 'up:Backspace', 'down:Enter']);
    expect(field.value).toBe('');
    expect(reachedPicture).toEqual([]);

    await act(async () => field.blur());
    expect(opened).toEqual([true, false]);
  } finally {
    await page.close();
  }
});
