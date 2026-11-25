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
const modifiers = { alt: false, ctrl: false, meta: false, shift: false };
const pointer = (action, extra = {}) => ({
  type: 'pointer', action, x: 10, y: 20, button: 0, buttons: action === 'up' ? 0 : 1, modifiers, ...extra,
});
const fixture = () => {
  const sent = [];
  let clock = 1000;
  const page = {
    sessionId: 'session', targetId: 'target',
    cdp: {
      isOpen: true,
      onEvent: () => () => {},
      async sendSession(_session, method, params) { sent.push({ method, ...params }); },
    },
  };
  const surface = createSurface({
    surfacePage: async () => page,
    dialogOpen: () => false,
    untilDialog: (_target, work) => work,
    contextMenu: { isOpen: false, observe: async () => {}, settle: async () => {} },
  }, { now: () => clock });
  return { surface, sent, advance: (ms) => { clock += ms; } };
};

test('preserves viewer key codes, including zero, and derives codes only for older viewers', async (t) => {
  const { surface, sent } = fixture();
  t.after(() => surface.close());
  for (const [extra, expected] of [[{ keyCode: 59 }, 59], [{ keyCode: 0 }, 0], [{}, 186]]) {
    await surface.input(['down', 'up'].map((action) => ({
      type: 'key', action, key: ';', code: 'Semicolon', modifiers, ...extra,
    })));
    assert.deepEqual(sent.filter((event) => event.method === 'Input.dispatchKeyEvent').slice(-2)
      .map(({ windowsVirtualKeyCode, nativeVirtualKeyCode }) => [windowsVirtualKeyCode, nativeVirtualKeyCode]),
    [[expected, expected], [expected, expected]]);
  }
});

test('counts double and triple clicks across batches and pairs each release', async (t) => {
  const { surface, sent, advance } = fixture();
  t.after(() => surface.close());
  for (let click = 0; click < 3; click += 1) {
    await surface.input([pointer('down')]);
    advance(20);
    await surface.input([pointer('up')]);
    advance(80);
  }
  assert.deepEqual(sent.filter((event) => event.method === 'Input.dispatchMouseEvent')
    .map((event) => event.clickCount), [1, 1, 2, 2, 3, 3]);
});

test('starts a new click sequence after timeout, position, button or view changes', async (t) => {
  for (const reset of ['timeout', 'position', 'button', 'view', 'drag']) {
    const { surface, sent, advance } = fixture();
    t.after(() => surface.close());
    await surface.input([pointer('down'), pointer('up')]);
    let extra = {};
    switch (reset) {
      case 'timeout': advance(501); break;
      case 'position': extra = { x: 40 }; break;
      case 'button': extra = { button: 1, buttons: 4 }; break;
      case 'view': surface.retarget(); break;
      case 'drag': await surface.input([pointer('move', { x: 40, buttons: 0 })]); break;
      default: throw new Error(`Unknown reset: ${reset}`);
    }
    await surface.input([pointer('down', extra), pointer('up', { ...extra, buttons: 0 })]);
    assert.deepEqual(sent.filter((event) => event.type === 'mousePressed' || event.type === 'mouseReleased')
      .slice(-2).map((event) => event.clickCount), [1, 1], reset);
  }
});

test('drag movement keeps Chrome button state and has no click count', async (t) => {
  const { surface, sent } = fixture();
  t.after(() => surface.close());
  await surface.input([pointer('down'), pointer('move', { x: 50, button: -1 }), pointer('up', { x: 50 })]);
  assert.deepEqual(sent.filter((event) => event.method === 'Input.dispatchMouseEvent')
    .map(({ type, button, clickCount }) => ({ type, button, clickCount })), [
    { type: 'mousePressed', button: 'left', clickCount: 1 },
    { type: 'mouseMoved', button: 'left', clickCount: 0 },
    { type: 'mouseReleased', button: 'left', clickCount: 1 },
  ]);
});
