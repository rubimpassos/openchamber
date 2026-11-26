import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import test from 'node:test';
import { WebSocket } from 'ws';
import { installCaptureGuard } from '../src/capture-guard.js';
import { connectCdp } from '../src/cdp-client.js';
import { createChromeProcess, resolveChromePath } from '../src/chrome-process.js';
import { createDevTools } from '../src/devtools.js';
import { createOriginRefusal } from '../src/origin-refusal.js';
import { createPolicyProxy } from '../src/policy-proxy.js';
import { applyViewport } from '../src/viewports.js';

const chromePath = resolveChromePath(process.env.CHROME_PATH);
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const evaluate = async (page, expression) => {
  const result = await page.cdp.sendSession(page.sessionId, 'Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, userGesture: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result?.value;
};
const frontend = (page, body) => evaluate(page, `(async () => {
  const SDK = await import('./core/sdk/sdk.js');
  const UI = await import('./ui/legacy/legacy.js');
  const target = SDK.TargetManager.TargetManager.instance().primaryPageTarget();
  if (!target) throw new Error('No inspected target');
  ${body}
})()`);
const socketRefused = (url, origin) => new Promise((resolve, reject) => {
  const socket = new WebSocket(url, { origin, handshakeTimeout: 2000 });
  socket.once('open', () => { socket.terminate(); reject(new Error('Unexpected socket admission')); });
  socket.once('unexpected-response', (_request, response) => {
    response.resume(); socket.terminate(); resolve(response.statusCode);
  });
  socket.once('error', (error) => {
    if (error.code === 'ECONNREFUSED' || /Unexpected server response/.test(error.message)) resolve('closed');
    else reject(error);
  });
});

test('bundled DevTools inspects one real page with guarded network, copy and paired teardown', { timeout: 45_000 }, async (context) => {
  let protectedHits = 0;
  const protectedServer = http.createServer((_request, response) => { protectedHits += 1; response.end('private'); });
  const protectedOrigin = `http://127.0.0.1:${await listen(protectedServer)}`;
  const server = http.createServer((request, response) => {
    if (request.url === '/data') {
      response.setHeader('content-type', 'application/json');
      response.end('{"proof":"network-body"}');
    } else {
      response.setHeader('content-type', 'text/html');
      response.end('<!doctype html><title>DevTools fixture</title><h1 id="subject">Original</h1><script>globalThis.answer = 42</script>');
    }
  });
  const origin = `http://127.0.0.1:${await listen(server)}`;
  const proxy = createPolicyProxy({ openchamberOrigins: [protectedOrigin], allowPrivateNetwork: true });
  const chrome = createChromeProcess({ chromePath, tabAudioCapture: true });
  let cdp;
  let devtools;
  context.after(async () => {
    await devtools?.dispose();
    cdp?.close();
    await chrome.close();
    await proxy.close();
    for (const fixture of [server, protectedServer]) {
      fixture.closeAllConnections();
      await new Promise((resolve) => fixture.close(resolve));
    }
  });
  const proxyAddress = await proxy.listen();
  const processInfo = await chrome.ensure();
  cdp = await connectCdp(processInfo.endpoint);
  await installCaptureGuard(cdp, { openchamberOrigins: [protectedOrigin] });
  const { browserContextId } = await cdp.send('Target.createBrowserContext', { proxyServer: proxyAddress, proxyBypassList: '<-loopback>' });
  const { targetId } = await cdp.send('Target.createTarget', { url: origin, browserContextId });
  const page = { cdp, targetId, sessionId: await cdp.attach(targetId) };
  await applyViewport(cdp, page.sessionId, { width: 1440, height: 900, scale: 1, mobile: false });
  let copied;
  const copy = new Promise((resolve) => { copied = resolve; });
  devtools = createDevTools({
    cdp, endpoint: processInfo.endpoint, proxyAddress, version: processInfo.version,
    refuses: createOriginRefusal([protectedOrigin]), onCopy: copied, onChange() {}, onError(error) { throw error; },
  });
  const inspected = await devtools.open(targetId, { size: { width: 1000, height: 700, scale: 1 } });
  // Wait on Chrome's frontend target registration, rather than a timer.
  await evaluate(inspected, `(async () => {
    const SDK = await import('./core/sdk/sdk.js');
    const manager = SDK.TargetManager.TargetManager.instance();
    if (!manager.primaryPageTarget()) await new Promise((resolve) => {
      const observer = { targetAdded() {
        if (manager.primaryPageTarget()) { manager.unobserveTargets(observer); resolve(); }
      }, targetRemoved() {} };
      manager.observeTargets(observer);
    });
    if (!globalThis.openchamberDevtoolsReady) await new Promise((resolve) => {
      const check = () => globalThis.openchamberDevtoolsReady ? resolve() : requestAnimationFrame(check);
      check();
    });
    return true;
  })()`);
  assert.equal(await frontend(inspected, `return (await target.runtimeAgent().invoke_evaluate({ expression: 'answer', returnByValue: true })).result.value;`), 42);
  assert.equal(await frontend(inspected, `
    const model = target.model(SDK.DOMModel.DOMModel);
    const root = await model.requestDocument();
    const id = await model.querySelector(root.id, '#subject');
    const result = await target.domAgent().invoke_setAttributeValue({ nodeId: id, name: 'data-proof', value: 'elements' });
    return result.getError() ?? 'edited';
  `), 'edited');
  assert.equal(await evaluate(page, `document.querySelector('#subject').dataset.proof`), 'elements');
  const body = await frontend(inspected, `
    const model = target.model(SDK.NetworkManager.NetworkManager);
    const loaded = new Promise((resolve) => {
      const listener = model.addEventListener(SDK.NetworkManager.Events.RequestFinished, (event) => {
        if (event.data.url().endsWith('/data')) {
          model.removeEventListener(SDK.NetworkManager.Events.RequestFinished, listener.listener);
          resolve(event.data);
        }
      });
    });
    await target.runtimeAgent().invoke_evaluate({ expression: "fetch('/data')", awaitPromise: true });
    const request = await loaded;
    return await target.networkAgent().invoke_getResponseBody({ requestId: request.requestId() });
  `);
  assert.equal(body.body, '{"proof":"network-body"}');
  assert.equal(await frontend(inspected, `
    const model = target.model(SDK.DebuggerModel.DebuggerModel);
    const paused = new Promise((resolve) => model.addEventListener(SDK.DebuggerModel.Events.DebuggerPaused, () => resolve(true)));
    const execution = target.runtimeAgent().invoke_evaluate({ expression: 'debugger; 1', returnByValue: true });
    await paused;
    const isPaused = model.isPaused();
    await target.debuggerAgent().invoke_resume();
    await execution;
    return isPaused;
  `), true);
  assert.equal(await frontend(inspected, `
    return (await target.runtimeAgent().invoke_evaluate({
      expression: 'navigator.mediaDevices.getDisplayMedia({video:true}).then(() => "unsafe", e => e.name)',
      awaitPromise: true, returnByValue: true
    })).result.value;
  `), 'NotAllowedError');
  const frontendCapture = await evaluate(inspected, `(async () => {
    if (typeof navigator.mediaDevices?.getDisplayMedia !== 'function') return 'unavailable';
    return navigator.mediaDevices.getDisplayMedia({video:true, preferCurrentTab:true}).then((stream) => {
      stream.getTracks().forEach((track) => track.stop());
      return 'granted';
    }, (error) => error.name);
  })()`);
  assert.equal(['NotAllowedError', 'unavailable'].includes(frontendCapture), true);
  // The service's isolated audio world deliberately retains native capture.
  // Its contexts, source and debugger frames must never reach the frontend.
  const isolated = await cdp.sendSession(page.sessionId, 'Page.createIsolatedWorld', {
    frameId: targetId, worldName: 'openchamber-tab-audio',
  });
  let privateScript;
  const stopScripts = cdp.onEvent((event) => {
    if (event.sessionId === page.sessionId && event.method === 'Debugger.scriptParsed'
      && event.params.executionContextId === isolated.executionContextId) privateScript = event.params.scriptId;
  });
  await cdp.sendSession(page.sessionId, 'Debugger.enable');
  const privateObject = await cdp.sendSession(page.sessionId, 'Runtime.evaluate', {
    contextId: isolated.executionContextId,
    expression: 'debugger; ({nativeCapture: String(navigator.mediaDevices.getDisplayMedia).includes("[native code]")})',
  });
  stopScripts();
  const properties = await cdp.sendSession(page.sessionId, 'Runtime.getProperties', { objectId: privateObject.result.objectId });
  assert.equal(properties.result.find((property) => property.name === 'nativeCapture').value.value, true);
  assert.equal(await frontend(inspected, `
    return (await target.runtimeAgent().invoke_evaluate({ contextId: ${isolated.executionContextId}, expression: '1' })).getError();
  `).then((error) => /not available for this page/.test(error)), true);
  assert.equal(await frontend(inspected, `
    return (await target.runtimeAgent().invoke_getProperties({ objectId: ${JSON.stringify(privateObject.result.objectId)} })).getError();
  `).then((error) => /not available for this page/.test(error)), true);
  assert.equal(await frontend(inspected, `
    return (await target.debuggerAgent().invoke_getScriptSource({ scriptId: ${JSON.stringify(privateScript)} })).getError();
  `).then((error) => /not available for this page/.test(error)), true);
  assert.equal(await frontend(inspected, `
    return (await target.runtimeAgent().invoke_evaluate({
      expression: ${JSON.stringify(`fetch('${protectedOrigin}/private').then(() => 'unsafe', () => 'blocked')`)},
      awaitPromise: true, returnByValue: true
    })).result.value;
  `), 'blocked');
  assert.equal(protectedHits, 0);
  await evaluate(inspected, `(async () => {
    const host = await import('./core/host/host.js');
    host.InspectorFrontendHost.InspectorFrontendHostInstance.copyText('devtools clipboard');
  })()`);
  assert.equal(await copy, 'devtools clipboard');
  await frontend(inspected, `await UI.InspectorView.InspectorView.instance().showPanel('elements'); return true;`);
  if (process.env.DEVTOOLS_EVIDENCE_DIR) {
    await fs.mkdir(process.env.DEVTOOLS_EVIDENCE_DIR, { recursive: true });
    const capture = await cdp.sendSession(inspected.sessionId, 'Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(`${process.env.DEVTOOLS_EVIDENCE_DIR}/devtools-desktop.png`, Buffer.from(capture.data, 'base64'));
  }
  await devtools.resize({ width: 390, height: 844, scale: 1 });
  assert.deepEqual(await evaluate(inspected, '[innerWidth, innerHeight]'), [390, 844]);
  assert.deepEqual(await evaluate(page, '[innerWidth, innerHeight]'), [1440, 900]);
  const privateUrl = await evaluate(inspected, `new URL(location.href).searchParams.get('ws')`);
  assert.equal(await socketRefused(`ws://${privateUrl}`, 'https://untrusted.test'), 401);
  assert.equal(await socketRefused(`ws://${privateUrl}wrong`, 'devtools://devtools'), 401);
  if (process.env.DEVTOOLS_EVIDENCE_DIR) {
    await fs.mkdir(process.env.DEVTOOLS_EVIDENCE_DIR, { recursive: true });
    const capture = await cdp.sendSession(inspected.sessionId, 'Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(`${process.env.DEVTOOLS_EVIDENCE_DIR}/devtools-mobile.png`, Buffer.from(capture.data, 'base64'));
  }
  await devtools.close();
  assert.equal(devtools.page, null);
  assert.equal(await socketRefused(`ws://${privateUrl}`, 'devtools://devtools'), 'closed');
  const contexts = await cdp.send('Target.getBrowserContexts');
  assert.deepEqual(contexts.browserContextIds, [browserContextId]);
});
