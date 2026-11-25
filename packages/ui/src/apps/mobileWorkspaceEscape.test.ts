import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { registerBackLayer } from '@/lib/mobileBackLayers';
import { handleMobileWorkspaceEscape } from './mobileWorkspaceEscape';

let dom: Window;
let restore: () => void;
let releaseLayer: (() => void) | null = null;

beforeEach(() => {
  dom = new Window({ url: 'http://localhost/' });
  const globals = { document: dom.document, Element: dom.Element, HTMLElement: dom.HTMLElement, KeyboardEvent: dom.KeyboardEvent };
  const descriptors = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  restore = () => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
});

afterEach(async () => {
  releaseLayer?.();
  releaseLayer = null;
  await dom.happyDOM.close();
  restore();
});

test('a nested sheet owns Escape before its workspace', () => {
  let closed = 0;
  const close = () => { closed += 1; };
  const release = registerBackLayer(() => undefined);
  releaseLayer = release;

  handleMobileWorkspaceEscape(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }), 'preview', close);
  expect(closed).toBe(0);

  release();
  releaseLayer = null;
  handleMobileWorkspaceEscape(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }), 'preview', close);
  expect(closed).toBe(1);
});

test('a consumed Escape cannot also dismiss the workspace', () => {
  let closed = 0;
  const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
  event.preventDefault();
  handleMobileWorkspaceEscape(event, 'preview', () => { closed += 1; });
  expect(closed).toBe(0);
});

test('terminal and IME Escape remain with their input owner', () => {
  let closed = 0;
  const close = () => { closed += 1; };
  handleMobileWorkspaceEscape(new KeyboardEvent('keydown', { key: 'Escape' }), 'terminal', close);
  handleMobileWorkspaceEscape(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true }), 'preview', close);
  expect(closed).toBe(0);
});
