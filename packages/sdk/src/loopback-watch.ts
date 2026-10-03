import { HostRequestError } from './host-errors.ts';
import type { LoopbackUrlResult } from './loopback.ts';

export type LoopbackWatchEvent =
  | { readonly type: 'data'; readonly text: string }
  | { readonly type: 'connection'; readonly state: 'connecting' | 'live' | 'unavailable'; readonly error?: HostRequestError };

/** Browser transport port. Mutable handlers belong to the current connection. */
export type LoopbackEventSource = {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: ((event: Event) => void) | null;
  readonly close: () => void;
};
/** Test seams for transport, time, and browser availability. No global mocks needed. */
export type LoopbackWatchRuntime = {
  readonly createSource: (url: string, init: EventSourceInit) => LoopbackEventSource;
  readonly schedule: (callback: () => void, delayMs: number) => () => void;
  readonly random: () => number;
  readonly isPaused: () => boolean;
  readonly onResume: (callback: () => void) => () => void;
};

const browserRuntime: LoopbackWatchRuntime = {
  createSource: (url, init) => {
    if (!('EventSource' in globalThis)) throw new HostRequestError('UNSUPPORTED', 'EventSource is unavailable.');
    return new EventSource(url, init);
  },
  schedule: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
  random: () => Math.random(),
  isPaused: () => ('navigator' in globalThis && !navigator.onLine)
    || ('document' in globalThis && document.visibilityState === 'hidden'),
  onResume: (callback) => {
    const resume = () => { if (!browserRuntime.isPaused()) callback(); };
    globalThis.addEventListener?.('online', resume);
    if ('document' in globalThis) document.addEventListener('visibilitychange', resume);
    return () => {
      globalThis.removeEventListener?.('online', resume);
      if ('document' in globalThis) document.removeEventListener('visibilitychange', resume);
    };
  },
};

/** Owns one URL admission, source or retry timer. Token expiry alone never reloads a healthy source. */
export const watchLoopback = (
  transport: { readonly mint: () => Promise<LoopbackUrlResult>; readonly signal: AbortSignal },
  listener: (event: LoopbackWatchEvent) => void,
  runtime: LoopbackWatchRuntime = browserRuntime,
): (() => void) => {
  const lifetime = new AbortController();
  let generation = 0;
  let failures = 0;
  let retire: (() => void) | null = null;
  let retry: (() => void) | null = null;

  const stop = (): void => {
    lifetime.abort();
    generation += 1;
    retire?.();
    retire = null;
    retry = null;
    removeResume();
    transport.signal.removeEventListener('abort', stop);
  };
  const unavailable = (error: HostRequestError): void => {
    if (lifetime.signal.aborted) return;
    generation += 1;
    retire?.();
    retire = null;
    // Refusals must not keep a hidden frame retrying after approval is revoked.
    const permanent = error.code === 'NOT_GRANTED' || error.code === 'UNSUPPORTED'
      || error.code === 'HOST_UNAVAILABLE' || error.code === 'BAD_PATH' || error.code === 'HOST_REJECTED';
    if (permanent) stop();
    listener({ type: 'connection', state: 'unavailable', error });
    if (lifetime.signal.aborted) return;
    const base = runtime.isPaused() ? 15_000 : Math.min(15_000, 1000 * 2 ** Math.min(failures, 4));
    failures += 1;
    const delay = Math.min(15_000, Math.round(base * (0.8 + runtime.random() * 0.4)));
    retry = connect;
    retire = runtime.schedule(connect, delay);
  };
  const connect = (): void => {
    if (lifetime.signal.aborted) return;
    retire?.();
    retire = null;
    retry = null;
    const attempt = ++generation;
    listener({ type: 'connection', state: 'connecting' });
    if (lifetime.signal.aborted) return;
    void transport.mint().then((result) => {
      if (lifetime.signal.aborted || attempt !== generation) return;
      let source: LoopbackEventSource;
      try {
        source = runtime.createSource(result.url, { withCredentials: false });
      } catch (error) {
        // Browser exceptions may embed the URL. Never forward their message or cause.
        unavailable(error instanceof HostRequestError ? error
          : new HostRequestError('HOST_REJECTED', 'Could not open the loopback stream.'));
        return;
      }
      retire = () => {
        source.onopen = null;
        source.onmessage = null;
        source.onerror = null;
        source.close();
      };
      source.onopen = () => {
        if (!lifetime.signal.aborted && attempt === generation) listener({ type: 'connection', state: 'live' });
      };
      source.onmessage = (event) => {
        if (lifetime.signal.aborted || attempt !== generation) return;
        // A handshake followed by an immediate error is not a healthy connection.
        failures = 0;
        listener({ type: 'data', text: event.data });
      };
      source.onerror = () => {
        if (attempt === generation) unavailable(new HostRequestError('DISCONNECTED', 'Loopback stream disconnected.'));
      };
    }, (error) => {
      if (attempt !== generation || lifetime.signal.aborted) return;
      unavailable(error instanceof HostRequestError ? error
        : new HostRequestError('HOST_REJECTED', 'Could not obtain a loopback URL.'));
    });
  };
  const removeResume = runtime.onResume(() => retry?.());
  // Return the disposer before delivering events, so listeners can stop even
  // the first admission and host.dispose can cancel a newly registered watch.
  transport.signal.addEventListener('abort', stop, { once: true });
  if (transport.signal.aborted) stop();
  else queueMicrotask(connect);
  return stop;
};
