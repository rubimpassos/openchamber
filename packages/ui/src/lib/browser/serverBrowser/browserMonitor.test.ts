import { describe, expect, test } from 'bun:test';

import {
  SERVER_BROWSER_HOLD_MS,
  SERVER_BROWSER_MEMORY_INTERVAL_MS,
  createServerBrowserMonitor,
  type ServerBrowserServiceStatus,
  type ServerBrowserWatch,
} from './browserMonitor';
import type { ServerBrowserResult } from './client';
import type { ServerBrowserMemory, ServerBrowserState } from './types';

type Call<A, R> = { readonly args: A; readonly answer: (result: R) => void };

const recorder = <A, R>() => {
  const waiting: Call<A, R>[] = [];
  const takers: Array<(call: Call<A, R>) => void> = [];
  return {
    call: (args: A) => new Promise<R>((answer) => {
      const call = { args, answer };
      const taker = takers.shift();
      if (taker) taker(call);
      else waiting.push(call);
    }),
    next: () => new Promise<Call<A, R>>((resolve) => {
      const call = waiting.shift();
      if (call) resolve(call);
      else takers.push(resolve);
    }),
    unanswered: () => waiting.length,
  };
};

const settle = async () => { for (let round = 0; round < 40; round += 1) await Promise.resolve(); };

const browserState = (version: string, generation = 1): ServerBrowserState => ({
  version,
  controller: 'none',
  viewerInControl: false,
  selectedScopeId: null,
  generation,
  help: null,
  chrome: { status: 'ready', message: '' },
  scopes: [],
});

const reading = (bytes: number): ServerBrowserMemory => ({ sampledAt: 1, bytesByScope: new Map([['scope', bytes]]) });

const IDLE: ServerBrowserWatch = { memoryKey: 'scope', agentActive: false, loading: false, panelFollows: false };

type World = {
  state: ServerBrowserState | null;
  watch: ServerBrowserWatch;
  status: ServerBrowserServiceStatus;
  now: number;
  currentOwner: boolean;
};

const setup = (initial: ServerBrowserState | null = null) => {
  const stateReads = recorder<{ since: string; waitMs: number } | undefined, ServerBrowserResult<ServerBrowserState>>();
  const memoryReads = recorder<undefined, ServerBrowserResult<ServerBrowserMemory>>();
  const closes = recorder<{ scopeId: string; generation: number }, ServerBrowserResult<ServerBrowserState>>();
  const waits = recorder<number, void>();
  const world: World = { state: initial, watch: IDLE, status: 'ready', now: 100_000, currentOwner: true };
  const harness = Object.assign(world, { stateReads, memoryReads, closes, waits });
  const monitor = createServerBrowserMonitor({
    currentState: () => harness.state,
    publishState: (state) => {
      harness.state = state;
      monitor.stateChanged();
    },
    clearState: () => { harness.state = null; },
    watch: () => harness.watch,
    serviceStatus: async () => harness.status,
    readState: stateReads.call,
    readMemory: () => memoryReads.call(undefined),
    closeScope: closes.call,
    now: () => harness.now,
    wait: waits.call,
    isCurrent: () => harness.currentOwner,
  });
  return { harness, monitor };
};

describe('server browser monitor', () => {
  test('a refresh reads the state once and measures memory once', async () => {
    const { harness, monitor } = setup();
    const refreshed = monitor.refresh();
    expect(monitor.getSnapshot().refreshing).toBe(true);
    (await harness.stateReads.next()).answer({ ok: true, data: browserState('v1') });
    (await harness.memoryReads.next()).answer({ ok: true, data: reading(512) });
    await refreshed;
    await settle();

    expect(harness.state?.version).toBe('v1');
    expect(monitor.getSnapshot()).toEqual({ memory: reading(512), readFailed: false, refreshing: false });
    expect(harness.stateReads.unanswered()).toBe(0);
    expect(harness.memoryReads.unanswered()).toBe(0);
  });

  test('a stopped service is not started: nothing is read and the old browsers go', async () => {
    const { harness, monitor } = setup(browserState('v1'));
    harness.status = 'stopped';
    await monitor.refresh();

    expect(harness.state).toBeNull();
    expect(harness.stateReads.unanswered()).toBe(0);
    expect(harness.memoryReads.unanswered()).toBe(0);
    expect(monitor.getSnapshot().readFailed).toBe(false);
  });

  test('a failed read keeps the last state and says the read failed', async () => {
    const { harness, monitor } = setup(browserState('v1'));
    const refreshed = monitor.refresh();
    (await harness.stateReads.next()).answer({ ok: false, error: 'Request failed.' });
    await refreshed;

    expect(harness.state?.version).toBe('v1');
    expect(monitor.getSnapshot().readFailed).toBe(true);
    expect(harness.memoryReads.unanswered()).toBe(0);
  });

  test('a provider without the memory route is asked once', async () => {
    const { harness, monitor } = setup();
    const refreshed = monitor.refresh();
    (await harness.stateReads.next()).answer({ ok: true, data: browserState('v1') });
    (await harness.memoryReads.next()).answer({ ok: false, error: 'not-found', status: 404 });
    await refreshed;

    const again = monitor.refresh();
    (await harness.stateReads.next()).answer({ ok: true, data: browserState('v2') });
    await again;
    await settle();

    expect(monitor.getSnapshot().memory).toBeNull();
    expect(harness.memoryReads.unanswered()).toBe(0);
  });

  for (const status of [undefined, 500]) {
    test(`a failed memory refresh clears the previous measurement with status ${status}`, async () => {
      const { harness, monitor } = setup();
      const first = monitor.refresh();
      (await harness.stateReads.next()).answer({ ok: true, data: browserState('v1') });
      (await harness.memoryReads.next()).answer({ ok: true, data: reading(512) });
      await first;
      await settle();

      const next = monitor.refresh();
      (await harness.stateReads.next()).answer({ ok: true, data: browserState('v1') });
      (await harness.memoryReads.next()).answer({ ok: false, error: 'Unavailable', status });
      await next;
      await settle();

      expect(monitor.getSnapshot().memory).toBeNull();
      expect(harness.state?.version).toBe('v1');
      monitor.dispose();
    });
  }

  test('changes inside the interval share one later reading, and a refresh does not wait for it', async () => {
    const { harness, monitor } = setup();
    const refreshed = monitor.refresh();
    (await harness.stateReads.next()).answer({ ok: true, data: browserState('v1') });
    (await harness.memoryReads.next()).answer({ ok: true, data: reading(100) });
    await refreshed;
    await settle();

    harness.now += 1_000;
    harness.watch = { ...IDLE, memoryKey: 'scope\tloaded' };
    monitor.stateChanged();
    harness.watch = { ...IDLE, memoryKey: 'scope\tloaded\ttwice' };
    monitor.stateChanged();
    const waited = await harness.waits.next();
    expect(waited.args).toBe(SERVER_BROWSER_MEMORY_INTERVAL_MS - 1_000);
    expect(harness.memoryReads.unanswered()).toBe(0);

    const forced = monitor.refresh();
    (await harness.stateReads.next()).answer({ ok: true, data: browserState('v2') });
    (await harness.memoryReads.next()).answer({ ok: true, data: reading(200) });
    await forced;
    await settle();

    expect(monitor.getSnapshot().memory).toEqual(reading(200));
    expect(harness.memoryReads.unanswered()).toBe(0);
    expect(harness.waits.unanswered()).toBe(0);
  });

  test('agent activity holds a read on the current version and follows until the agent stops', async () => {
    const { harness, monitor } = setup(browserState('v1'));
    monitor.agentActed();
    const first = await harness.stateReads.next();
    expect(first.args).toEqual({ since: 'v1', waitMs: SERVER_BROWSER_HOLD_MS });

    harness.watch = { ...IDLE, agentActive: true };
    first.answer({ ok: true, data: browserState('v2') });
    const second = await harness.stateReads.next();
    expect(second.args).toEqual({ since: 'v2', waitMs: SERVER_BROWSER_HOLD_MS });

    harness.watch = IDLE;
    second.answer({ ok: true, data: browserState('v3') });
    await settle();

    expect(harness.state?.version).toBe('v3');
    expect(harness.stateReads.unanswered()).toBe(0);
  });

  test('a long agent action is followed through a hold that ran out', async () => {
    const { harness, monitor } = setup(browserState('v1'));
    harness.watch = { ...IDLE, agentActive: true };
    monitor.stateChanged();
    const first = await harness.stateReads.next();
    harness.now += SERVER_BROWSER_HOLD_MS;
    first.answer({ ok: true, data: browserState('v1') });

    expect((await harness.stateReads.next()).args).toEqual({ since: 'v1', waitMs: SERVER_BROWSER_HOLD_MS });
  });

  test('a page that keeps loading is given up after one hold that ran out', async () => {
    const { harness, monitor } = setup(browserState('v1'));
    harness.watch = { ...IDLE, loading: true };
    monitor.stateChanged();
    const first = await harness.stateReads.next();
    harness.now += SERVER_BROWSER_HOLD_MS;
    first.answer({ ok: true, data: browserState('v1') });
    await settle();

    expect(harness.stateReads.unanswered()).toBe(0);
  });

  test('a provider that answers a hold at once is not asked in a loop', async () => {
    const { harness, monitor } = setup(browserState('v1'));
    harness.watch = { ...IDLE, agentActive: true };
    monitor.stateChanged();
    (await harness.stateReads.next()).answer({ ok: true, data: browserState('v1') });
    await settle();

    expect(harness.stateReads.unanswered()).toBe(0);
  });

  test('while the Browser panel follows the service, agent activity adds no request', async () => {
    const { harness, monitor } = setup(browserState('v1'));
    harness.watch = { ...IDLE, agentActive: true, panelFollows: true };
    monitor.agentActed();
    monitor.stateChanged();
    await settle();

    expect(harness.stateReads.unanswered()).toBe(0);
  });

  test('a provider without the state route is asked once and reports no failure', async () => {
    const { harness, monitor } = setup();
    const refreshed = monitor.refresh();
    (await harness.stateReads.next()).answer({ ok: false, error: 'not-found', status: 404 });
    await refreshed;
    await monitor.refresh();
    monitor.agentActed();
    await settle();

    expect(monitor.getSnapshot().readFailed).toBe(false);
    expect(harness.stateReads.unanswered()).toBe(0);
  });

  for (const retire of [false, true]) {
    test(`closing retries with the current generation and retires its result when disposed: ${retire}`, async () => {
      const { harness, monitor } = setup(browserState('v1', 3));
      const closed = monitor.close('scope');
      const stale = await harness.closes.next();
      expect(stale.args).toEqual({ scopeId: 'scope', generation: 3 });
      stale.answer({ ok: false, error: 'The browser view changed before the dock command ran', status: 409 });
      (await harness.stateReads.next()).answer({ ok: true, data: browserState('v2', 4) });
      const retried = await harness.closes.next();
      expect(retried.args).toEqual({ scopeId: 'scope', generation: 4 });
      if (retire) monitor.dispose();
      retried.answer({ ok: true, data: browserState('v3', 5) });

      expect((await closed).ok).toBe(!retire);
      expect(harness.state?.version).toBe(retire ? 'v2' : 'v3');
    });
  }

  test('a refused close leaves the browsers as they were', async () => {
    const { harness, monitor } = setup(browserState('v1', 3));
    const closed = monitor.close('scope');
    (await harness.closes.next()).answer({
      ok: false,
      error: 'Dock controls are available only while the shared surface is idle or to the viewer in control',
      status: 409,
    });

    expect(await closed).toMatchObject({ ok: false, status: 409 });
    expect(harness.state?.version).toBe('v1');
    expect(harness.closes.unanswered()).toBe(0);
  });

  test('a disposed monitor refuses a delayed confirmation without sending a close', async () => {
    const { harness, monitor } = setup(browserState('v1'));
    monitor.dispose();
    const closing = monitor.close('scope');
    await settle();

    expect(harness.closes.unanswered()).toBe(0);
    expect((await closing).ok).toBe(false);
  });

  test('a runtime change while refreshing a stale generation prevents a close retry', async () => {
    const { harness, monitor } = setup(browserState('v1', 3));
    const closing = monitor.close('scope');
    (await harness.closes.next()).answer({
      ok: false, error: 'The browser view changed before the dock command ran', status: 409,
    });
    const refresh = await harness.stateReads.next();
    harness.currentOwner = false;
    refresh.answer({ ok: true, data: browserState('v2', 4) });
    await settle();

    expect(harness.closes.unanswered()).toBe(0);
    expect((await closing).ok).toBe(false);
    expect(harness.state?.version).toBe('v1');
    monitor.dispose();
  });
});
