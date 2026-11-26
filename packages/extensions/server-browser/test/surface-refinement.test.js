import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier === '@openchamber/sdk'
      ? new URL('../../../sdk/src/index.ts', import.meta.url).href : specifier, context);
  },
});
const { createSurface } = await import('../src/surface.js');

// Chrome is the external boundary. The surface and its scheduling run for real.
const fixture = async (t, { loading = false, devtools = false, scale = 2 } = {}) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const listeners = new Set();
  const captures = [];
  const motion = Buffer.from('motion frame');
  const sharp = Buffer.from('high density frame');
  let resolveCapture = null;
  const page = {
    targetId: 'shown', sessionId: 'shown-session', devtools,
    cdp: {
      isOpen: true,
      onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      async sendSession(sessionId, method, params) {
        if (method !== 'Page.captureScreenshot') return {};
        captures.push({ sessionId, ...params });
        if (resolveCapture) return new Promise((resolve) => { resolveCapture = resolve; });
        return { data: sharp.toString('base64') };
      },
    },
  };
  const runtime = {
    isLoading: loading,
    title: 'Page',
    surfaceViewport: { width: 390, height: 844, scale },
    surfacePage: async () => page,
    dialogOpen: () => false,
    contextMenu: { isOpen: false },
  };
  const surface = createSurface(runtime);
  t.after(async () => {
    await surface.close();
    assert.equal(listeners.size, 0, 'surface releases its CDP listeners');
  });
  const emit = (method, params = {}, sessionId = page.sessionId) => {
    for (const listener of listeners) listener({ method, params, sessionId });
  };
  const frame = () => emit('Page.screencastFrame', {
    sessionId: 1, data: motion.toString('base64'), metadata: { deviceWidth: 390, deviceHeight: 844 },
  });
  const read = () => surface.frame({ after: 0, wait: 0 });
  const tick = async () => { t.mock.timers.tick(180); return read(); };
  await read();
  return {
    surface, runtime, emit, frame, read, tick, captures, motion, sharp,
    holdCapture() { resolveCapture = () => {}; },
    finishCapture() { resolveCapture({ data: sharp.toString('base64') }); resolveCapture = null; },
  };
};

test('does not capture a loading page and refines on main-frame completion without another screencast frame', async (t) => {
  const f = await fixture(t, { loading: true });
  f.frame();
  assert.deepEqual((await f.read()).bytes, f.motion, 'motion stays available while loading');
  await f.tick();
  assert.equal(f.captures.length, 0, 'no expensive capture during initial navigation');

  for (const [sessionId, frameId] of [['other-session', 'shown'], ['shown-session', 'child']]) {
    f.emit('Page.frameStoppedLoading', { frameId }, sessionId);
    await f.tick();
    assert.equal(f.captures.length, 0, 'another session or child cannot resume refinement');
  }
  f.runtime.isLoading = false;
  f.emit('Page.frameStoppedLoading', { frameId: 'shown' });
  const refined = await f.tick();
  assert.deepEqual(f.captures, [{
    sessionId: 'shown-session', format: 'jpeg', quality: 88, optimizeForSpeed: true,
  }], 'capture keeps Chrome surface density defaults');
  assert.deepEqual(refined.bytes, f.sharp);
  assert.deepEqual([refined.width, refined.height, refined.mime, refined.sequence], [390, 844, 'image/jpeg', 2]);
});

test('navigation cancels a pending refinement and ignores unrelated load completion', async (t) => {
  const f = await fixture(t);
  f.frame();
  f.runtime.isLoading = true;
  f.emit('Page.frameStartedLoading', { frameId: 'shown' });
  f.emit('Page.frameNavigated', { frame: { id: 'replacement', url: 'https://example.test/' } });
  f.runtime.isLoading = false;
  f.emit('Page.frameStoppedLoading', { frameId: 'child' });
  await f.tick();
  assert.equal(f.captures.length, 0, 'only completion of the current main frame resumes');
  f.emit('Page.frameStoppedLoading', { frameId: 'replacement' });
  assert.deepEqual((await f.tick()).bytes, f.sharp);
});

test('a navigation invalidates an in-flight refinement before it can publish', async (t) => {
  const f = await fixture(t);
  f.holdCapture();
  f.frame();
  await f.tick();
  assert.equal(f.captures.length, 1);
  f.runtime.isLoading = true;
  f.emit('Page.frameStartedLoading', { frameId: 'shown' });
  f.finishCapture();
  assert.deepEqual((await f.read()).bytes, f.motion, 'old document screenshot is discarded');
  await f.tick();
  assert.equal(f.captures.length, 1, 'discard does not start another capture during loading');
  f.runtime.isLoading = false;
  f.emit('Page.frameStoppedLoading', { frameId: 'shown' });
  assert.deepEqual((await f.tick()).bytes, f.sharp);
  assert.equal(f.captures.length, 2);
});

test('DevTools refines independently of the inspected tab and waits for its own navigation', async (t) => {
  const f = await fixture(t, { devtools: true, loading: true });
  f.frame();
  assert.deepEqual((await f.tick()).bytes, f.sharp, 'inspected-tab loading does not gate DevTools');
  f.emit('Page.frameStartedLoading', { frameId: 'shown' });
  f.emit('Page.frameStoppedLoading', { frameId: 'shown' }, 'inspected-session');
  f.emit('Page.frameStoppedLoading', { frameId: 'child' });
  f.frame();
  await f.tick();
  assert.equal(f.captures.length, 1, 'DevTools waits for its own main frame');
  f.emit('Page.frameStoppedLoading', { frameId: 'shown' });
  const refined = await f.tick();
  assert.deepEqual(refined.bytes, f.sharp);
  assert.equal(f.captures.length, 2);
});

test('a loaded page ignores child and foreign loading and refines only at high density', async (t) => {
  for (const scale of [1, 2]) {
    await t.test(`density ${scale}`, async (child) => {
      const f = await fixture(child, { scale });
      f.emit('Page.frameStartedLoading', { frameId: 'shown' }, 'other-session');
      f.emit('Page.frameNavigated', { frame: { id: 'child', parentId: 'shown' } });
      f.emit('Page.frameStartedLoading', { frameId: 'child' });
      f.frame();
      assert.deepEqual((await f.tick()).bytes, scale === 2 ? f.sharp : f.motion);
      assert.equal(f.captures.length, scale === 2 ? 1 : 0);
    });
  }
});

test('retarget and close cancel navigation-resumed refinement', async (t) => {
  for (const action of ['retarget', 'close']) {
    await t.test(action, async (child) => {
      const f = await fixture(child, { loading: true });
      f.frame();
      f.runtime.isLoading = false;
      f.emit('Page.frameStoppedLoading', { frameId: 'shown' });
      await f.surface[action]();
      child.mock.timers.tick(180);
      assert.equal(f.captures.length, 0);
    });
  }
});
