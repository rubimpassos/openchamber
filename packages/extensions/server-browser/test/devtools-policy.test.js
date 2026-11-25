import assert from 'node:assert/strict';
import test from 'node:test';
import { createDevToolsPolicy } from '../src/devtools-policy.js';

const wire = (message, sessionId) => JSON.stringify(sessionId ? { ...message, sessionId } : message);
const command = (policy, method, params = {}, sessionId) => policy.command(wire({ id: 1, method, params }, sessionId));
const event = (policy, method, params = {}, sessionId) => policy.event(wire({ method, params }, sessionId));
const reply = (policy, result, sessionId) => policy.event(wire({ id: 1, result }, sessionId));
const policyForPage = () => createDevToolsPolicy({
  targetId: 'page', version: { product: 'Chrome/test' }, refuses: (url) => url.startsWith('http://protected.test'),
});

test('rejects browser authority, files, tracing and future methods', () => {
  for (const [method, params] of [
    ['Browser.close', {}], ['Browser.setDownloadBehavior', { downloadPath: '/tmp/export' }],
    ['Target.createTarget', { url: 'https://example.com' }], ['Target.getTargets', {}],
    ['Target.setDiscoverTargets', { discover: true }], ['Target.createBrowserContext', {}],
    ['Target.attachToBrowserTarget', {}], ['Target.sendMessageToTarget', { message: '{}' }],
    ['Target.autoAttachRelated', { targetId: 'page' }],
    ['Target.attachToTarget', { targetId: 'sibling', flatten: true }],
    ['DOM.setFileInputFiles', { files: ['/etc/hosts'] }],
    ['Input.dispatchDragEvent', { data: { files: ['/etc/hosts'] } }],
    ['Network.getAllCookies', {}], ['Storage.getCookies', {}],
    ['Storage.clearDataForOrigin', { origin: 'https://sibling.test' }],
    ['Tracing.start', {}], ['Tracing.end', {}], ['Page.futureDangerousMethod', {}],
    ['Debugger.getStackTrace', { stackTraceId: { id: 'foreign', debuggerId: 'sibling' } }],
    ['Page.navigate', { url: 'file:///etc/hosts' }],
    ['Page.navigate', { url: 'http://protected.test/private' }],
    ['Runtime.evaluate', { expression: '1', browserContextId: 'other' }],
  ]) {
    const result = command(policyForPage(), method, params);
    assert.equal(result.ok, false, method);
    assert.equal(result.response?.error.code, -32000, method);
  }
});

test('answers version metadata without forwarding any Browser command', () => {
  assert.deepEqual(command(policyForPage(), 'Browser.getVersion'), {
    ok: false, response: { id: 1, result: { product: 'Chrome/test' } },
  });
});

test('admits descendant sessions only through the owned attachment ancestry', () => {
  const policy = policyForPage();
  assert.equal(command(policy, 'Target.setAutoAttach', { autoAttach: true, flatten: true, waitForDebuggerOnStart: false }).ok, true);
  assert.equal(reply(policy, {}).ok, true);
  assert.equal(event(policy, 'Target.attachedToTarget', {
    sessionId: 'worker-session', targetInfo: { targetId: 'worker', type: 'worker' },
  }).ok, true);
  assert.equal(command(policy, 'Runtime.evaluate', { expression: '1 + 1' }, 'worker-session').ok, true);
  assert.equal(reply(policy, { result: { type: 'number', value: 2 } }, 'worker-session').ok, true);
  assert.equal(event(policy, 'Target.detachedFromTarget', { sessionId: 'worker-session' }).ok, true);
  assert.equal(command(policy, 'Runtime.evaluate', { expression: '1' }, 'worker-session').ok, false);
  for (const type of ['page', 'browser', 'shared_worker', 'service_worker']) {
    assert.equal(event(policy, 'Target.attachedToTarget', {
      sessionId: `foreign-${type}`, targetInfo: { targetId: `foreign-${type}`, type, browserContextId: 'same', openerId: 'page' },
    }).ok, false, type);
  }
  assert.equal(event(policyForPage(), 'Target.attachedToTarget', {
    sessionId: 'unrequested', targetInfo: { targetId: 'worker', type: 'worker' },
  }).ok, false);
});

test('correlates responses and binds object, DOM, context and stream handles to their session', () => {
  const policy = policyForPage();
  assert.equal(reply(policy, { result: { objectId: 'forged' } }).ok, false);
  assert.equal(command(policy, 'Runtime.evaluate', { expression: '({})' }).ok, true);
  assert.equal(reply(policy, { result: { type: 'object', objectId: 'owned', value: { objectId: 'forged' } } }).ok, true);
  assert.equal(command(policy, 'Runtime.getProperties', { objectId: 'forged' }).ok, false);
  assert.equal(command(policy, 'Runtime.getProperties', { objectId: 'owned' }).ok, true);
  assert.equal(reply(policy, {}).ok, true);
  assert.equal(event(policy, 'Runtime.executionContextCreated', { context: { id: 3, uniqueId: 'ctx', auxData: { isDefault: true } } }).ok, true);
  assert.equal(command(policy, 'Runtime.evaluate', { expression: '1', contextId: 4 }).ok, false);
  assert.equal(command(policy, 'Runtime.evaluate', { expression: '1', contextId: 3 }).ok, true);
  assert.equal(reply(policy, {}).ok, true);
  assert.equal(event(policy, 'Runtime.executionContextDestroyed', { executionContextId: 3 }).ok, true);
  assert.equal(command(policy, 'Runtime.evaluate', { expression: '1', contextId: 3 }).ok, false);
  assert.equal(command(policy, 'DOM.getDocument').ok, true);
  assert.equal(reply(policy, { root: { nodeId: 5, backendNodeId: 7 } }).ok, true);
  assert.equal(command(policy, 'DOM.setAttributeValue', { nodeId: 5, name: 'class', value: 'changed' }).ok, true);
  assert.equal(reply(policy, {}).ok, true);
  assert.equal(event(policy, 'DOM.documentUpdated').ok, true);
  assert.equal(command(policy, 'DOM.setAttributeValue', { nodeId: 5, name: 'class', value: 'stale' }).ok, false);
  assert.equal(command(policy, 'Network.loadNetworkResource', { frameId: 'page', url: 'https://example.com/map', options: { includeCredentials: false } }).ok, true);
  assert.equal(reply(policy, { resource: { success: true, stream: 'stream' } }).ok, true);
  assert.equal(command(policy, 'IO.read', { handle: 'unknown' }).ok, false);
  assert.equal(command(policy, 'IO.read', { handle: 'stream', size: 1024 }).ok, true);
  assert.equal(reply(policy, { data: 'source' }).ok, true);
  assert.equal(command(policy, 'IO.close', { handle: 'stream' }).ok, true);
  assert.equal(reply(policy, {}).ok, true);
  assert.equal(command(policy, 'IO.read', { handle: 'stream' }).ok, false);
});

test('excludes isolated service worlds, their objects, scripts and paused frames', () => {
  const policy = policyForPage();
  assert.equal(event(policy, 'Runtime.executionContextCreated', {
    context: { id: 7, uniqueId: 'audio', name: 'openchamber-tab-audio', auxData: { isDefault: false, type: 'isolated' } },
  }).message, null);
  assert.equal(command(policy, 'Runtime.evaluate', { expression: 'navigator.mediaDevices.getDisplayMedia({video:true})', contextId: 7 }).ok, false);
  assert.equal(command(policy, 'Runtime.callFunctionOn', { functionDeclaration: 'function(){return this}', uniqueContextId: 'audio' }).ok, false);
  assert.equal(event(policy, 'Debugger.scriptParsed', { scriptId: 'private-script', executionContextId: 7 }).message, null);
  assert.equal(command(policy, 'Debugger.getScriptSource', { scriptId: 'private-script' }).ok, false);
  command(policy, 'Debugger.setBreakpointByUrl', { urlRegex: '.*', lineNumber: 0 });
  reply(policy, { breakpointId: 'breakpoint', locations: [{ scriptId: 'unreported-private-script', lineNumber: 0 }] });
  assert.equal(command(policy, 'Debugger.getScriptSource', { scriptId: 'unreported-private-script' }).ok, false);
  const paused = event(policy, 'Debugger.paused', {
    callFrames: [{ callFrameId: 'private-frame', location: { scriptId: 'private-script' }, this: { objectId: 'private-object' } }],
  });
  assert.equal(paused.message, null);
  assert.equal(paused.command.method, 'Debugger.resume');
  assert.equal(paused.command.id < 0, true);
  assert.equal(command(policy, 'Debugger.evaluateOnCallFrame', { callFrameId: 'private-frame', expression: 'this' }).ok, false);
  assert.equal(command(policy, 'Runtime.getProperties', { objectId: 'private-object' }).ok, false);
  assert.equal(policy.event(JSON.stringify({ id: paused.command.id, result: {} })).message, null);
});

test('retires released object groups and nested property handles without consuming a historical quota', () => {
  const policy = policyForPage();
  assert.equal(command(policy, 'Runtime.evaluate', { expression: '({nested:{}})', objectGroup: 'console' }).ok, true);
  assert.equal(reply(policy, { result: { type: 'object', objectId: 'root' } }).ok, true);
  assert.equal(command(policy, 'Runtime.getProperties', { objectId: 'root' }).ok, true);
  assert.equal(reply(policy, { result: [{ name: 'nested', value: { type: 'object', objectId: 'nested' } }] }).ok, true);
  assert.equal(command(policy, 'Runtime.getProperties', { objectId: 'nested' }).ok, true);
  assert.equal(reply(policy, {}).ok, true);
  assert.equal(command(policy, 'Runtime.releaseObjectGroup', { objectGroup: 'console' }).ok, true);
  assert.equal(reply(policy, {}).ok, true);
  for (const objectId of ['root', 'nested']) assert.equal(command(policy, 'Runtime.getProperties', { objectId }).ok, false);
  for (let index = 0; index < 17_000; index += 1) {
    const objectId = `released-${index}`;
    assert.equal(command(policy, 'Runtime.evaluate', { expression: '({})' }).ok, true);
    assert.equal(reply(policy, { result: { type: 'object', objectId } }).ok, true);
    assert.equal(command(policy, 'Runtime.releaseObject', { objectId }).ok, true);
    assert.equal(reply(policy, {}).ok, true);
  }
});

test('retires script authority across context destruction and reused renderer script IDs', () => {
  const policy = policyForPage();
  event(policy, 'Runtime.executionContextCreated', { context: { id: 1, auxData: { isDefault: true } } });
  command(policy, 'Runtime.compileScript', { expression: '1', sourceURL: 'snippet.js', persistScript: true, executionContextId: 1 });
  reply(policy, { scriptId: 'compiled' });
  assert.equal(command(policy, 'Runtime.runScript', { scriptId: 'compiled', executionContextId: 1 }).ok, true);
  reply(policy, {});
  event(policy, 'Debugger.scriptParsed', { scriptId: 'reused', executionContextId: 1 });
  assert.equal(command(policy, 'Debugger.getScriptSource', { scriptId: 'reused' }).ok, true);
  reply(policy, { scriptSource: 'page' });
  event(policy, 'Runtime.executionContextDestroyed', { executionContextId: 1 });
  assert.equal(command(policy, 'Debugger.getScriptSource', { scriptId: 'reused' }).ok, false);
  event(policy, 'Runtime.executionContextCreated', { context: { id: 2, auxData: { isDefault: false } } });
  event(policy, 'Debugger.scriptParsed', { scriptId: 'reused', executionContextId: 2 });
  assert.equal(command(policy, 'Debugger.getScriptSource', { scriptId: 'reused' }).ok, false);
  assert.equal(event(policy, 'Debugger.paused', { callFrames: [{ callFrameId: 'hidden', location: { scriptId: 'reused' } }] }).message, null);
  event(policy, 'Runtime.executionContextsCleared');
  event(policy, 'Runtime.executionContextCreated', { context: { id: 3, auxData: { isDefault: true } } });
  event(policy, 'Debugger.scriptParsed', { scriptId: 'reused', executionContextId: 3 });
  assert.equal(command(policy, 'Debugger.getScriptSource', { scriptId: 'reused' }).ok, true);
});

test('bounds retained pending ownership bytes independently of the command count', () => {
  const policy = policyForPage();
  const session = 's'.repeat(512);
  command(policy, 'Target.setAutoAttach', { autoAttach: true, flatten: true, waitForDebuggerOnStart: false });
  reply(policy, {});
  event(policy, 'Target.attachedToTarget', { sessionId: session, targetInfo: { targetId: 'worker', type: 'worker' } });
  event(policy, 'Runtime.executionContextCreated', { context: { id: 1, uniqueId: 'c'.repeat(512) } }, session);
  command(policy, 'Runtime.evaluate', { expression: '({})' }, session);
  reply(policy, { result: { type: 'object', objectId: 'o'.repeat(512) } }, session);
  assert.equal(command(policy, 'Runtime.evaluate', { expression: '1', objectGroup: 'g'.repeat(513) }, session).ok, false);
  let refused = false;
  for (let id = 2; id < 1002; id += 1) {
    const result = policy.command(JSON.stringify({
      id, sessionId: session, method: 'Runtime.callFunctionOn',
      params: { functionDeclaration: 'function(){return 1}', objectId: 'o'.repeat(512), uniqueContextId: 'c'.repeat(512), objectGroup: 'g'.repeat(512) },
    }));
    if (!result.ok) { refused = true; break; }
  }
  assert.equal(refused, true);
});

test('refuses sibling and stale handles, malformed protocol and unbounded outstanding work', () => {
  const policy = policyForPage();
  for (const raw of ['[]', 'null', '{', '{"id":1,"method":"DOM.getDocument","sessionId":"foreign"}']) {
    assert.equal(policy.command(raw).ok, false);
  }
  assert.equal(command(policy, 'Target.setAutoAttach', { autoAttach: true, flatten: true, waitForDebuggerOnStart: false }).ok, true);
  assert.equal(reply(policy, {}).ok, true);
  assert.equal(event(policy, 'Target.attachedToTarget', { sessionId: 'child', targetInfo: { targetId: 'frame', type: 'iframe' } }).ok, true);
  assert.equal(command(policy, 'Runtime.evaluate', { expression: '({})' }, 'child').ok, true);
  assert.equal(reply(policy, { result: { objectId: 'child-object' } }, 'child').ok, true);
  assert.equal(command(policy, 'Runtime.getProperties', { objectId: 'child-object' }).ok, false);
  assert.equal(command(policy, 'Network.loadNetworkResource', { frameId: 'sibling', url: 'https://example.com', options: {} }).ok, false);
  const saturated = policyForPage();
  for (let id = 0; id < 1024; id += 1) assert.equal(saturated.command(JSON.stringify({ id, method: 'DOM.getDocument' })).ok, true);
  assert.equal(saturated.command(JSON.stringify({ id: 1024, method: 'DOM.getDocument' })).ok, false);
  assert.equal(saturated.command(JSON.stringify({ id: 1, method: 'DOM.getDocument' })).ok, false);
});
