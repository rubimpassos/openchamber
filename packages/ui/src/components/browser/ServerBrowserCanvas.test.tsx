import { act } from 'react';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import { I18nProvider } from '@/lib/i18n';
import { clearRuntimeUrlAuthToken, setRuntimeUrlAuthToken } from '@/lib/runtime-auth';
import { ZoneInteractiveContext } from '@/components/layout/zoneInteractiveContext';
import { surfaceViewerMessageSchema, type SurfaceHostMessage, type SurfaceViewerMessage } from '@openchamber/sdk/schemas';
import { ServerBrowserCanvas } from './ServerBrowserCanvas';

const deferred = <Value,>() => {
  let resolve: (value: Value) => void;
  let reject: (error: Error) => void;
  const promise = new Promise<Value>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve: (value: Value) => resolve(value), reject: (error: Error) => reject(error) };
};

// The network and image decoder are browser-engine boundaries. The client and canvas run for real.
class Socket {
  static opened = deferred<Socket>();
  readyState = 0;
  binaryType = 'arraybuffer';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  sent: SurfaceViewerMessage[] = [];
  constructor() { Socket.opened.resolve(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  text(message: SurfaceHostMessage) { this.onmessage?.({ data: JSON.stringify(message) }); }
  send(message: string) { this.sent.push(surfaceViewerMessageSchema.parse(JSON.parse(message))); }
  close() { this.readyState = 3; this.onclose?.({ code: 1000, reason: '' }); }
  frame(viewId: string, seq = 1) {
    this.text({ type: 'frame', seq, viewId, width: 320, height: 200, mime: 'image/png', bytes: 1, agentActive: false });
    this.onmessage?.({ data: new Uint8Array([seq]).buffer });
  }
}

type Bitmap = { readonly width: number; readonly height: number; readonly close: () => void };
let root: Root;
let dom: Window;
let restore: () => void;
let decoded: ReturnType<typeof deferred<Bitmap>>;
let draws: Bitmap[];
let readiness: Array<string | null>;
const noop = () => undefined;
const onPresented = (viewId: string | null) => { readiness.push(viewId); };
const render = async (visible = true) => {
  await act(async () => root.render(
    <I18nProvider><ZoneInteractiveContext.Provider value={visible}>
      <ServerBrowserCanvas guestId="canvas-fixture" onViewer={noop} onControl={noop} onConnection={noop} onPresented={onPresented} />
    </ZoneInteractiveContext.Provider></I18nProvider>,
  ));
};
const finishDecode = async () => {
  const bitmap = { width: 320, height: 200, close: noop };
  await act(async () => { decoded.resolve(bitmap); await decoded.promise; });
  return bitmap;
};

beforeEach(() => {
  dom = new Window({ url: 'http://localhost/' });
  decoded = deferred<Bitmap>();
  Socket.opened = deferred<Socket>();
  draws = [];
  readiness = [];
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator, Element: dom.Element,
    HTMLElement: dom.HTMLElement, ResizeObserver: dom.ResizeObserver, WebSocket: Socket,
    createImageBitmap: () => decoded.promise, IS_REACT_ACT_ENVIRONMENT: true,
  };
  const descriptors = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  restore = () => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
  Object.defineProperty(dom.HTMLCanvasElement.prototype, 'getContext', {
    value: () => ({ drawImage: (bitmap: Bitmap) => { draws.push(bitmap); } }),
  });
  setRuntimeUrlAuthToken('canvas-fixture', Date.now() + 60_000);
  root = createRoot(document.createElement('div'));
});

afterEach(async () => {
  await act(async () => root.unmount());
  clearRuntimeUrlAuthToken();
  await dom.happyDOM.close();
  restore();
});

test('readiness waits for the host to confirm the successfully drawn view', async () => {
  await render();
  const socket = await Socket.opened.promise;
  await act(async () => { socket.open(); socket.frame('view-B'); });
  const bitmap = await finishDecode();
  expect(draws).toEqual([bitmap]);
  expect(socket.sent).toEqual([{ type: 'ack', seq: 1, presented: true }]);
  expect(readiness.at(-1)).toBeNull();

  await act(async () => socket.text({ type: 'presented', seq: 1, viewId: 'view-A' }));
  expect(readiness.at(-1)).toBeNull();
  // Another image of the same view can finish drawing before the first host confirmation arrives.
  decoded = deferred<Bitmap>();
  await act(async () => socket.frame('view-B', 2));
  await finishDecode();
  await act(async () => socket.text({ type: 'presented', seq: 1, viewId: 'view-B' }));
  expect(readiness.at(-1)).toBe('view-B');
});

test('failed decoding releases capacity without making the view ready', async () => {
  await render();
  const socket = await Socket.opened.promise;
  await act(async () => { socket.open(); socket.frame('view-B'); });
  await act(async () => {
    decoded.reject(new DOMException('Invalid image', 'InvalidStateError'));
    await decoded.promise.catch(noop);
  });
  expect(draws).toEqual([]);
  expect(socket.sent).toEqual([{ type: 'ack', seq: 1, presented: false }]);
  await act(async () => socket.text({ type: 'presented', seq: 1, viewId: 'view-B' }));
  expect(readiness.at(-1)).toBeNull();
});

test('a decode retired by a hidden browser zone cannot draw or ACK on its replacement', async () => {
  await render();
  const first = await Socket.opened.promise;
  await act(async () => { first.open(); first.frame('view-A'); });
  await render(false);
  expect(first.readyState).toBe(3);
  Socket.opened = deferred<Socket>();
  await render();
  const replacement = await Socket.opened.promise;
  const late = decoded;
  decoded = deferred<Bitmap>();
  await act(async () => { replacement.open(); replacement.frame('view-B'); });
  const bitmap = await finishDecode();
  await act(async () => { late.resolve({ width: 1, height: 1, close: noop }); await late.promise; });
  expect(draws).toEqual([bitmap]);
  expect(first.sent).toEqual([]);
  expect(replacement.sent).toEqual([{ type: 'ack', seq: 1, presented: true }]);
  await act(async () => replacement.text({ type: 'presented', seq: 1, viewId: 'view-B' }));
  expect(readiness.at(-1)).toBe('view-B');
});

test('a decode from before reconnect cannot draw or acknowledge a reused sequence', async () => {
  await render();
  const first = await Socket.opened.promise;
  await act(async () => { first.open(); first.frame('view-A'); });
  Socket.opened = deferred<Socket>();
  await act(async () => {
    first.close();
    dom.dispatchEvent(new dom.Event('online'));
  });
  const replacement = await Socket.opened.promise;
  const late = decoded;
  decoded = deferred<Bitmap>();
  await act(async () => { replacement.open(); replacement.frame('view-B'); });
  const bitmap = await finishDecode();
  await act(async () => { late.resolve({ width: 1, height: 1, close: noop }); await late.promise; });

  expect(draws).toEqual([bitmap]);
  expect(first.sent).toEqual([]);
  expect(replacement.sent).toEqual([{ type: 'ack', seq: 1, presented: true }]);
  await act(async () => replacement.text({ type: 'presented', seq: 1, viewId: 'view-B' }));
  expect(readiness.at(-1)).toBe('view-B');
});
