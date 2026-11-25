import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { useServerBrowserBackHandler } from './useServerBrowserBackHandler';

test('mobile Back consumes current page history and releases the shell when history is exhausted', async () => {
  const dom = new Window({ url: 'http://localhost/' });
  const globals = { window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement, Node: dom.Node, IS_REACT_ACT_ENVIRONMENT: true };
  const descriptors = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.body.appendChild(document.createElement('div')));
  let handler: (() => boolean) | null = null;
  const register = (next: (() => boolean) | null) => { handler = next; };
  const pressBack = () => {
    if (!handler) throw new Error('No Back handler registered');
    return handler();
  };
  const calls: string[] = [];
  const Probe: React.FC<{ action: Parameters<typeof useServerBrowserBackHandler>[1] }> = ({ action }) => {
    useServerBrowserBackHandler(register, action);
    return null;
  };
  try {
    await act(async () => root.render(<Probe action={async () => { calls.push('page'); return null; }} />));
    expect(pressBack()).toBe(true);
    expect(calls).toEqual(['page']);
    await act(async () => root.render(<Probe action={async () => { calls.push('devtools'); return null; }} />));
    expect(pressBack()).toBe(true);
    expect(calls).toEqual(['page', 'devtools']);
    await act(async () => root.render(<Probe action={null} />));
    expect(pressBack()).toBe(false);
    await act(async () => root.unmount());
    expect(handler).toBeNull();
  } finally {
    await act(async () => root.unmount());
    await dom.happyDOM.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
