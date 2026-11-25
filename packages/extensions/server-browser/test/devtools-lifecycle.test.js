import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createBrowserManager } from '../src/browser-manager.js';
import { createBrowserRuntime } from '../src/browser-runtime.js';
import { resolveChromePath } from '../src/chrome-process.js';
import { createService } from '../src/service.js';

const chromePath = resolveChromePath(process.env.CHROME_PATH);
const evaluate = async (page, expression) => {
  const response = await page.cdp.sendSession(page.sessionId, 'Runtime.evaluate', { expression, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
  return response.result?.value;
};
const token = 'devtools-fixture-token';

test('DevTools uses the existing surface with controller, generation and scope isolation', { timeout: 60_000 }, async (context) => {
  const fixture = http.createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end('<!doctype html><title>Inspected page</title><input id="input" value="original">');
  });
  const port = await new Promise((resolve) => fixture.listen(0, '127.0.0.1', () => resolve(fixture.address().port)));
  const runtimes = new Map();
  const manager = createBrowserManager({
    createRuntime(scope) {
      const runtime = createBrowserRuntime({ chromePath, allowPrivateNetwork: true });
      runtimes.set(scope.sessionId, runtime);
      return runtime;
    },
  });
  const service = createService({ runtime: manager, token });
  const address = await service.listen();
  const origin = `http://${address.host}:${address.port}`;
  const request = (body, headers = {}) => fetch(`${origin}/browser/devtools`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify(body),
  });
  context.after(async () => {
    await service.close();
    fixture.closeAllConnections();
    await new Promise((resolve) => fixture.close(resolve));
  });
  await manager.perform('browser.open', { url: `http://127.0.0.1:${port}` }, undefined, { directory: '/fixture', sessionId: 'one' });
  await manager.surfaceResize({ width: 1000, height: 700 });
  const runtime = runtimes.get('one');
  const page = await runtime.ensurePage();
  const before = await manager.surfaceFrame({ after: 0, wait: 5000 });
  assert.ok(before?.bytes.length);
  for (const body of [
    { open: 'true', generation: manager.state().generation },
    { open: true }, { open: true, generation: manager.state().generation, targetId: 'sibling' },
    { open: true, generation: manager.state().generation, url: 'ws://foreign' },
  ]) assert.equal((await request(body)).status, 400);
  assert.equal((await fetch(`${origin}/browser/devtools`, { method: 'POST', body: '{}' })).status, 401);
  await manager.surfaceControl('user', 'owner');
  assert.equal((await request({ open: true, generation: manager.state().generation })).status, 409);
  const headers = { 'x-surface-viewer': 'owner', 'x-surface-viewer-controls': '1', 'x-surface-frame-seq': String(before.sequence) };
  const oldGeneration = manager.state().generation;
  const opened = await request({ open: true, generation: oldGeneration }, headers);
  assert.equal(opened.status, 200, await opened.clone().text());
  const state = await opened.json();
  assert.equal(state.scopes[0].devtools, true);
  assert.equal(JSON.stringify(state).includes('/devtools/'), false);
  assert.equal(JSON.stringify(state).includes('devtools://'), false);
  const shown = await runtime.surfacePage();
  assert.notEqual(shown.targetId, page.targetId);
  assert.equal((await runtime.ensurePage()).targetId, page.targetId);
  assert.deepEqual(await evaluate(page, '[innerWidth,innerHeight]'), [1440, 900]);
  assert.equal((await request({ open: false, generation: oldGeneration }, headers)).status, 409);
  await assert.rejects(manager.surfaceInput([{ type: 'text', text: 'stale' }], { viewer: 'owner', frameSeq: before.sequence }), /view changed/i);
  const toolsFrame = await manager.surfaceFrame({ after: before.sequence, wait: 5000 });
  assert.equal(toolsFrame.width, 1000);
  assert.equal(toolsFrame.height, 700);
  await evaluate(shown, `document.body.insertAdjacentHTML('beforeend','<input id="devtools-input">'); document.querySelector('#devtools-input').focus()`);
  await manager.surfaceInput([{ type: 'text', text: 'frontend-input' }], { viewer: 'owner', frameSeq: toolsFrame.sequence });
  assert.equal(await evaluate(shown, `document.querySelector('#devtools-input').value`), 'frontend-input');
  assert.equal(await evaluate(page, `document.querySelector('#input').value`), 'original');
  await manager.setDevTools(false, manager.state().generation, { viewer: 'owner', frameSeq: toolsFrame.sequence });
  await assert.rejects(manager.surfaceInput([{ type: 'text', text: 'stale-tools' }], { viewer: 'owner', frameSeq: toolsFrame.sequence }), /view changed/i);
  const pageFrame = await manager.surfaceFrame({ after: toolsFrame.sequence, wait: 5000 });
  await manager.setDevTools(true, manager.state().generation, { viewer: 'owner', frameSeq: pageFrame.sequence });
  await manager.surfaceControl('none');
  await manager.perform('browser.snapshot', {}, undefined, { directory: '/fixture', sessionId: 'one' });
  assert.equal((await runtime.ensurePage()).targetId, page.targetId);
  await manager.surfaceControl('agent');
  assert.equal((await request({ open: false, generation: manager.state().generation })).status, 409);
  await manager.surfaceControl('none');
  await manager.newTab(manager.state().generation);
  assert.equal(runtime.devtools, false);
  await manager.setViewport({ mode: 'auto', mobile: false }, manager.state().generation);
  await manager.setDevTools(true, manager.state().generation);
  await manager.surfaceResize({ width: 600, height: 400 });
  assert.deepEqual(await evaluate(await runtime.ensurePage(), '[innerWidth,innerHeight]'), [1000, 700]);
  await manager.selectTab(page.targetId, manager.state().generation);
  assert.equal(runtime.devtools, false);
  assert.deepEqual(await evaluate(await runtime.ensurePage(), '[innerWidth,innerHeight]'), [600, 400]);
  await manager.setDevTools(true, manager.state().generation);
  await manager.closeTab(runtime.tabs.find((tab) => tab.active).id, manager.state().generation);
  assert.equal(runtime.devtools, false);
  await manager.setDevTools(true, manager.state().generation);
  await manager.perform('browser.open', { url: `http://127.0.0.1:${port}` }, undefined, { directory: '/fixture', sessionId: 'two' });
  const second = manager.state().scopes.find((scope) => scope.sessionId === 'two');
  await manager.selectScope(second.id, manager.state().generation);
  assert.equal(runtime.devtools, false);
  assert.equal(runtimes.get('two').devtools, false);
  await manager.setDevTools(true, manager.state().generation);
  const secondRuntime = runtimes.get('two');
  await manager.closeScope(second.id, manager.state().generation);
  assert.equal(secondRuntime.devtools, false);
  assert.equal(runtime.browserProcess !== null, true);
  await manager.selectScope(manager.state().scopes[0].id, manager.state().generation);
  await manager.setDevTools(true, manager.state().generation);
  await service.close();
  assert.equal(runtime.devtools, false);
  assert.equal(runtime.browserProcess, null);
});

test('a scope switch cancels DevTools before cold Chrome startup completes', { timeout: 15_000 }, async (context) => {
  let entered;
  let resume;
  const starting = new Promise((resolve) => { entered = resolve; });
  const resumed = new Promise((resolve) => { resume = resolve; });
  const runtimes = new Map();
  const manager = createBrowserManager({ createRuntime(scope) {
    const runtime = createBrowserRuntime({ chromePath: async () => { entered(); await resumed; return chromePath; } });
    runtimes.set(scope.sessionId, runtime);
    return runtime;
  } });
  context.after(() => manager.close());
  await manager.openScope({ directory: '/fixture', sessionId: 'cold' }, manager.state().generation);
  await manager.openScope({ directory: '/fixture', sessionId: 'other' }, manager.state().generation);
  const cold = manager.state().scopes.find((scope) => scope.sessionId === 'cold');
  const other = manager.state().selectedScopeId;
  await manager.selectScope(cold.id, manager.state().generation);
  const rejected = assert.rejects(manager.setDevTools(true, manager.state().generation), /view changed/i);
  await starting;
  await manager.selectScope(other, manager.state().generation);
  resume();
  await rejected;
  assert.equal(runtimes.get('cold').devtools, false);
  assert.equal(manager.state().selectedScopeId, other);
  const page = await runtimes.get('cold').ensurePage();
  assert.deepEqual((await page.cdp.send('Target.getBrowserContexts')).browserContextIds, [page.contextId]);
});

test('a scope switch during the real context-menu CDP close cancels the opening', { timeout: 15_000 }, async (context) => {
  const runtimes = new Map();
  const manager = createBrowserManager({ createRuntime(scope) {
    const runtime = createBrowserRuntime({ chromePath });
    runtimes.set(scope.sessionId, runtime);
    return runtime;
  } });
  context.after(() => manager.close());
  await manager.openScope({ directory: '/fixture', sessionId: 'menu' }, manager.state().generation);
  const runtime = runtimes.get('menu');
  const page = await runtime.ensurePage();
  await manager.openScope({ directory: '/fixture', sessionId: 'other' }, manager.state().generation);
  const other = manager.state().selectedScopeId;
  await manager.selectScope(manager.state().scopes.find((scope) => scope.sessionId === 'menu').id, manager.state().generation);
  const modifiers = { alt: false, ctrl: false, meta: false, shift: false };
  await runtime.surfaceInput([
    { type: 'pointer', action: 'down', x: 10, y: 10, button: 2, buttons: 2, modifiers },
    { type: 'pointer', action: 'up', x: 10, y: 10, button: 2, buttons: 0, modifiers },
  ]);
  assert.equal(runtime.contextMenu.isOpen, true);
  let entered;
  let release;
  const closing = new Promise((resolve) => { entered = resolve; });
  const resumed = new Promise((resolve) => { release = resolve; });
  const send = page.cdp.sendSession;
  page.cdp.sendSession = (sessionId, method, params) => {
    if (method === 'Runtime.callFunctionOn') {
      entered();
      return resumed.then(() => send(sessionId, method, params));
    }
    return send(sessionId, method, params);
  };
  const rejected = assert.rejects(manager.setDevTools(true, manager.state().generation), /view changed/i);
  await closing;
  await manager.selectScope(other, manager.state().generation);
  release();
  await rejected;
  page.cdp.sendSession = send;
  assert.equal(runtime.devtools, false);
  assert.equal(manager.state().selectedScopeId, other);
});
