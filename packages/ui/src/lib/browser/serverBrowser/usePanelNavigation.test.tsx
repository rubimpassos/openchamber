import { act } from 'react';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createRoot, type Root } from 'react-dom/client';

import { installHookTestDom } from '@/components/session/sidebar/test-utils/testDom';
import { requestBrowserTabLoad } from '../devServerWait';
import type { ServerBrowserScope, ServerBrowserState } from './types';
import { usePanelNavigation } from './usePanelNavigation';

const DIRECTORY = '/panel-navigation';
const TAB_ID = 'browser:browser';
const CHROME_TAB = 'chrome-tab';
const WORKING_PAGE = 'http://localhost:3000/';

type PanelProps = {
  readonly sessionId: string;
  readonly scope: ServerBrowserScope | null;
  readonly chromeTabId: string | null;
};

const scopeOf = (sessionId: string, page: { readonly url: string; readonly active: boolean }): ServerBrowserScope => ({
  id: JSON.stringify([DIRECTORY, sessionId]),
  directory: DIRECTORY,
  sessionId,
  profile: null,
  signIn: false,
  selected: true,
  url: page.url,
  title: '',
  isLoading: false,
  canGoBack: false,
  canGoForward: false,
  tabs: [{ id: CHROME_TAB, url: page.url, title: '', isLoading: false, active: page.active }],
  viewport: null,
  problems: { errors: 0, warnings: 0 },
  zoomLevel: 0,
});
const showing = (sessionId: string, url: string): PanelProps => ({
  sessionId, scope: scopeOf(sessionId, { url, active: true }), chromeTabId: CHROME_TAB,
});

let dom: ReturnType<typeof installHookTestDom>;
let root: Root;
let shown: ReturnType<typeof usePanelNavigation> | undefined;
// The dock transport: records each address sent and holds it until the test settles it.
let sent: string[];
let inFlight: Promise<ServerBrowserState | null>;
let settle: () => void;
const navigate = (url: string): Promise<ServerBrowserState | null> => {
  sent.push(url);
  inFlight = new Promise((resolve) => { settle = () => resolve(null); });
  return inFlight;
};

const Panel = (props: PanelProps) => {
  shown = usePanelNavigation({ ...props, directory: DIRECTORY, tabID: TAB_ID, navigate, error: null, disabled: false });
  return null;
};
const render = async (props: PanelProps) => {
  await act(async () => root.render(<Panel {...props} />));
};
const navigation = () => {
  if (shown === undefined) throw new Error('The panel must be mounted before reading its navigation');
  return shown;
};
const finishNavigation = async () => {
  await act(async () => {
    settle();
    await inFlight;
  });
};

beforeEach(() => {
  dom = installHookTestDom();
  root = createRoot(dom.container);
  shown = undefined;
  sent = [];
});

afterEach(async () => {
  await act(async () => root.unmount());
  dom.restore();
});

test('an address the person asks for replaces a page that works', async () => {
  await render(showing('ses_a', WORKING_PAGE));

  await act(async () => navigation().load('localhost:4192'));

  expect(sent).toEqual(['http://localhost:4192/']);
  expect(navigation()).toMatchObject({ pending: true, requestedUrl: 'localhost:4192' });
  await finishNavigation();
  expect(navigation()).toMatchObject({ pending: false, requestedUrl: null });
});

test('an address asked for before the chat\'s Chrome tab is ready loads once that tab is selected', async () => {
  await render({ sessionId: 'ses_a', scope: null, chromeTabId: null });
  await act(async () => navigation().load('localhost:4192'));
  expect(navigation()).toMatchObject({ pending: true, requestedUrl: 'localhost:4192' });

  // The chat's browser opens blank, then the panel tab claims its Chrome tab, then that tab is selected.
  await render({ sessionId: 'ses_a', scope: scopeOf('ses_a', { url: 'about:blank', active: false }), chromeTabId: null });
  await render({ sessionId: 'ses_a', scope: scopeOf('ses_a', { url: 'about:blank', active: false }), chromeTabId: CHROME_TAB });
  expect(sent).toEqual([]);
  expect(navigation().requestedUrl).toBe('localhost:4192');

  await render(showing('ses_a', 'about:blank'));
  expect(sent).toEqual(['http://localhost:4192/']);

  // State snapshots that arrive while the address loads, and after it, send nothing more.
  await render(showing('ses_a', 'about:blank'));
  await finishNavigation();
  await render(showing('ses_a', 'http://localhost:4192/'));
  expect(sent).toHaveLength(1);
  expect(navigation()).toMatchObject({ pending: false, requestedUrl: null });
});

test('an address asked for in one chat never loads in another chat\'s browser', async () => {
  await render({ sessionId: 'ses_a', scope: null, chromeTabId: null });
  await act(async () => navigation().load('localhost:4192'));

  await render(showing('ses_b', WORKING_PAGE));
  expect(navigation().pending).toBe(false);
  await render(showing('ses_a', 'about:blank'));

  expect(sent).toEqual([]);
});

test('a link to a tab that shows a working page only brings it in front', async () => {
  await render(showing('ses_a', WORKING_PAGE));
  await act(async () => requestBrowserTabLoad(DIRECTORY, TAB_ID, 'http://localhost:4192/'));
  expect(sent).toEqual([]);

  // The same link loads in a tab that shows nothing yet.
  await render(showing('ses_a', 'about:blank'));
  await act(async () => requestBrowserTabLoad(DIRECTORY, TAB_ID, 'http://localhost:4192/'));
  expect(sent).toEqual(['http://localhost:4192/']);
  await finishNavigation();
});
