import React, { act } from 'react';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { I18nProvider } from '@/lib/i18n';
import type { ServerBrowserScope, ServerBrowserState } from '@/lib/browser/serverBrowser/types';
import { usePanelNavigation } from '@/lib/browser/serverBrowser/usePanelNavigation';

import { BrowserToolbar } from './BrowserToolbar';
import { useBrowserAddress } from './useBrowserAddress';

const DIRECTORY = '/address-draft';
const SESSION = 'ses_a';
const CHROME_TAB = 'chrome-tab';
const BLANK = 'about:blank';
const NO_ACTION = () => undefined;

type PanelProps = {
  readonly tabID: string;
  /** Null until the chat's browser has opened. */
  readonly pageUrl: string | null;
};

const scopeShowing = (url: string): ServerBrowserScope => ({
  id: JSON.stringify([DIRECTORY, SESSION]),
  directory: DIRECTORY,
  sessionId: SESSION,
  profile: null,
  signIn: false,
  selected: true,
  url,
  title: '',
  isLoading: false,
  canGoBack: false,
  canGoForward: false,
  tabs: [{ id: CHROME_TAB, url, title: '', isLoading: false, active: true }],
  viewport: null,
  problems: { errors: 0, warnings: 0 },
  zoomLevel: 0,
});

// The dock transport: records each address sent and holds it until the test settles it.
let sent: string[];
let inFlight: Promise<ServerBrowserState | null>;
let settle: () => void;
const navigate = (url: string): Promise<ServerBrowserState | null> => {
  sent.push(url);
  inFlight = new Promise((resolve) => { settle = () => resolve(null); });
  return inFlight;
};

/** The address row of a Server Browser panel tab, wired as `ServerBrowserLiveView` wires it. */
const AddressRow: React.FC<PanelProps> = ({ tabID, pageUrl }) => {
  const scope = React.useMemo(() => (pageUrl === null ? null : scopeShowing(pageUrl)), [pageUrl]);
  const navigation = usePanelNavigation({
    directory: DIRECTORY, tabID, sessionId: SESSION, scope, chromeTabId: scope ? CHROME_TAB : null,
    navigate, error: null, disabled: false,
  });
  const address = useBrowserAddress({ directory: DIRECTORY, tabID, requestedUrl: navigation.requestedUrl, pageUrl: scope?.url });
  return (
    <BrowserToolbar
      address={address.value}
      addressOwner={address.owner}
      onAddressChange={address.edit}
      onAddressFocusChange={address.setFocused}
      onSubmit={navigation.load}
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

let dom: Window;
let restoreGlobals: () => void;
let render: (props: PanelProps) => Promise<void>;
let unmount: () => Promise<void>;

beforeEach(async () => {
  dom = new Window({ url: 'http://localhost/' });
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node, ResizeObserver: dom.ResizeObserver,
    MutationObserver: dom.MutationObserver, getComputedStyle: dom.getComputedStyle.bind(dom),
    Event: dom.Event, KeyboardEvent: dom.KeyboardEvent, MouseEvent: dom.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const descriptors = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  restoreGlobals = () => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
  const { createRoot } = await import('react-dom/client');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  render = (props) => act(async () => root.render(<I18nProvider><AddressRow {...props} /></I18nProvider>));
  unmount = () => act(async () => root.unmount());
  sent = [];
});

afterEach(async () => {
  await unmount();
  await dom.happyDOM.close();
  restoreGlobals();
});

const addressField = (): HTMLInputElement => {
  const field = document.querySelector<HTMLInputElement>('input[aria-label="Browser address"]');
  if (!field) throw new Error('The address field is not mounted');
  return field;
};
const focusAddress = () => act(async () => addressField().focus());
const blurAddress = () => act(async () => addressField().blur());
const type = async (text: string) => {
  const setValue = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')?.set;
  if (!setValue) throw new Error('The field has no value setter');
  await act(async () => {
    setValue.call(addressField(), text);
    addressField().dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const pressEnter = () => act(async () => {
  addressField().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
});
const finishNavigation = async () => {
  await act(async () => {
    settle();
    await inFlight;
  });
};

test('an address typed while the chat\'s browser opens is the one that loads', async () => {
  await render({ tabID: 'tab-a', pageUrl: null });
  await focusAddress();
  await type('localhost:4192');

  await render({ tabID: 'tab-a', pageUrl: BLANK });
  expect(addressField().value).toBe('localhost:4192');
  await render({ tabID: 'tab-a', pageUrl: 'http://localhost:3000/' });
  expect(addressField().value).toBe('localhost:4192');

  await pressEnter();
  expect(sent).toEqual(['http://localhost:4192/']);
});

test('a submitted address holds the field until its page has loaded', async () => {
  await render({ tabID: 'tab-a', pageUrl: null });
  await focusAddress();
  await type('localhost:4192');
  await pressEnter();
  expect(sent).toEqual([]);

  await render({ tabID: 'tab-a', pageUrl: BLANK });
  expect(sent).toEqual(['http://localhost:4192/']);
  expect(addressField().value).toBe('localhost:4192');

  await render({ tabID: 'tab-a', pageUrl: 'http://localhost:4192/app' });
  await finishNavigation();
  expect(addressField().value).toBe('http://localhost:4192/app');
});

test('a field nobody is typing in follows the page', async () => {
  await render({ tabID: 'tab-a', pageUrl: 'http://localhost:3000/' });
  expect(addressField().value).toBe('http://localhost:3000/');

  await focusAddress();
  await render({ tabID: 'tab-a', pageUrl: 'http://localhost:3000/redirected' });
  expect(addressField().value).toBe('http://localhost:3000/redirected');
  expect(addressField().selectionStart).toBe(0);
  expect(addressField().selectionEnd).toBe('http://localhost:3000/redirected'.length);

  await type('localhost:4192');
  await blurAddress();
  expect(addressField().value).toBe('localhost:4192');
  await render({ tabID: 'tab-a', pageUrl: 'http://localhost:3000/next' });
  expect(addressField().value).toBe('http://localhost:3000/next');
});

test('another panel tab starts without the draft of the one before and keeps its own', async () => {
  await render({ tabID: 'tab-a', pageUrl: null });
  await focusAddress();
  await type('localhost:4192');

  await render({ tabID: 'tab-b', pageUrl: null });
  expect(document.activeElement === addressField()).toBe(true);
  expect(addressField().value).toBe('');

  await render({ tabID: 'tab-b', pageUrl: BLANK });
  expect(addressField().selectionStart).toBe(0);
  expect(addressField().selectionEnd).toBe(BLANK.length);
  await type('localhost:5000');
  await render({ tabID: 'tab-b', pageUrl: 'http://localhost:3000/booted' });
  expect(addressField().value).toBe('localhost:5000');

  await render({ tabID: 'tab-a', pageUrl: BLANK });
  expect(addressField().value).toBe(BLANK);
  expect(addressField().selectionStart).toBe(0);
  expect(addressField().selectionEnd).toBe(BLANK.length);
});
