import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserManager } from '../src/browser-manager.js';
import { createService } from '../src/service.js';

test('browser versions ignore input activity while retaining material URL, control, DevTools and error changes', async (context) => {
  let clock = 10;
  const runtime = {
    url: 'about:blank',
    tabs: [{ id: 'page', active: true }],
    devtools: false,
    async perform(_action, parameters) { runtime.url = parameters.url; return {}; },
    async command(name, parameters) {
      if (name === 'navigate') runtime.url = parameters.url;
      if (name === 'devtools') runtime.devtools = parameters.open;
    },
    async surfaceInput() {},
    surfaceControl() {},
    onDead() { return () => {}; },
    onTabsChanged() { return () => {}; },
    async close() {},
  };
  const manager = createBrowserManager({ createRuntime: () => runtime, now: () => clock });
  const service = createService({ runtime: manager, token: 'state-fixture' });
  const address = await service.listen();
  context.after(() => service.close());
  await manager.perform('browser.open', { url: 'https://first.test' }, undefined, { directory: '/fixture', sessionId: 'state' });
  await manager.surfaceControl('user', 'viewer');
  const state = async () => {
    const response = await fetch(`http://${address.host}:${address.port}/browser/state`, {
      headers: { authorization: 'Bearer state-fixture', 'x-surface-viewer': 'viewer', 'x-surface-viewer-controls': '1' },
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const original = await state();
  for (let index = 0; index < 3; index += 1) {
    clock += 1;
    await manager.surfaceInput([{ type: 'text', text: 'input' }], { viewer: 'viewer', frameSeq: 0 });
    const touched = await state();
    assert.equal(touched.version, original.version);
    assert.equal(touched.scopes[0].lastActivityAt, clock);
  }
  await manager.navigate('https://changed.test', manager.state().generation, { viewer: 'viewer' });
  const navigated = await state();
  assert.notEqual(navigated.version, original.version);
  await manager.surfaceControl('none');
  const released = await state();
  assert.notEqual(released.version, navigated.version);
  await manager.setDevTools(true, manager.state().generation);
  const opened = await state();
  assert.equal(opened.scopes[0].devtools, true);
  assert.notEqual(opened.version, released.version);
  await manager.surfaceControl('user', 'viewer');
  const controlling = await state();
  runtime.surfaceInput = async () => { throw new Error('Fixture input failed'); };
  await assert.rejects(manager.surfaceInput([{ type: 'text', text: 'error' }], { viewer: 'viewer', frameSeq: 0 }), /Fixture input failed/);
  const failed = await state();
  assert.equal(failed.scopes[0].lastError, 'Fixture input failed');
  assert.notEqual(failed.version, controlling.version);
});
