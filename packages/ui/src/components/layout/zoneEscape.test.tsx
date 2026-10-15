import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';

const withDom = async (run: () => Promise<void>) => {
  const dom = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node,
    Event: dom.Event, KeyboardEvent: dom.KeyboardEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  try {
    await run();
  } finally {
    await dom.happyDOM.close();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
};

test('Escape closes the zone, except on what a pane draws over itself to answer Escape', () => withDom(async () => {
  const { createRoot } = await import('react-dom/client');
  const { closeZoneOnEscape } = await import('./zoneEscape');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let closes = 0;
  const answered: string[] = [];

  // Given a zone frame that closes on Escape, holding a plain button and a page's dialog drawn over the Browser pane.
  function Zone() {
    return (
      <div onKeyDownCapture={(event) => closeZoneOnEscape(event, true, () => { closes += 1; })}>
        <button id="plain" type="button">Plain</button>
        <div data-owns-escape="true" onKeyDown={(event) => { if (event.key === 'Escape') answered.push('cancel'); }}>
          <button id="ok" type="button">OK</button>
        </div>
      </div>
    );
  }
  const pressEscape = (id: string) => {
    document.getElementById(id)?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  };

  try {
    await act(async () => { root.render(<Zone />); });

    // When Escape is pressed on the dialog's button, then the dialog gets it and the zone stays open.
    await act(async () => { pressEscape('ok'); });
    expect(answered).toEqual(['cancel']);
    expect(closes).toBe(0);

    // When Escape is pressed anywhere else in the zone, then the zone closes.
    await act(async () => { pressEscape('plain'); });
    expect(closes).toBe(1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
}));
