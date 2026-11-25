import assert from 'node:assert/strict';
import test from 'node:test';
import { connectCdp } from '../src/cdp-client.js';
import { createChromeProcess, resolveChromePath } from '../src/chrome-process.js';
import { createDevTools } from '../src/devtools.js';
import { createPolicyProxy } from '../src/policy-proxy.js';

const chromePath = resolveChromePath(process.env.CHROME_PATH);

for (const failure of ['target creation fails', 'opening is closed']) {
  test(`DevTools reclaims its context and listener when ${failure}`, { timeout: 15_000 }, async (context) => {
    const chrome = createChromeProcess({ chromePath });
    const proxy = createPolicyProxy();
    const proxyAddress = await proxy.listen();
    const processInfo = await chrome.ensure();
    const cdp = await connectCdp(processInfo.endpoint);
    context.after(async () => { cdp.close(); await chrome.close(); await proxy.close(); });
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    let entered;
    let release;
    const creating = new Promise((resolve) => { entered = resolve; });
    const resumed = new Promise((resolve) => { release = resolve; });
    // Fault only the external Chrome command, while context allocation and
    // disposal still run against the real browser.
    const client = {
      ...cdp,
      get isOpen() { return cdp.isOpen; },
      async send(method, params) {
        if (method === 'Target.createTarget') {
          entered();
          await resumed;
          if (failure === 'target creation fails') throw new Error('Fixture target creation failed');
        }
        return cdp.send(method, params);
      },
    };
    const devtools = createDevTools({
      cdp: client, endpoint: processInfo.endpoint, proxyAddress, version: processInfo.version,
      refuses: () => false, onCopy() {}, onChange() {}, onError(error) { throw error; },
    });
    context.after(() => devtools.dispose());
    const opening = devtools.open(targetId, { size: { width: 800, height: 600, scale: 1 } });
    const rejected = assert.rejects(opening, failure === 'target creation fails' ? /Fixture target creation failed/ : /closed while opening/);
    await creating;
    const closed = failure === 'opening is closed' ? devtools.close() : Promise.resolve();
    release();
    await rejected;
    await closed;
    assert.equal(devtools.page, null);
    assert.deepEqual((await cdp.send('Target.getBrowserContexts')).browserContextIds, []);
  });
}

test('Chrome stopping during frontend navigation rejects startup without an unhandled load rejection', { timeout: 15_000 }, async (context) => {
  const chrome = createChromeProcess({ chromePath });
  const proxy = createPolicyProxy();
  const proxyAddress = await proxy.listen();
  const processInfo = await chrome.ensure();
  const cdp = await connectCdp(processInfo.endpoint);
  let stopped;
  context.after(async () => { await stopped; cdp.close(); await chrome.close(); await proxy.close(); });
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const client = {
    ...cdp,
    get isOpen() { return cdp.isOpen; },
    sendSession(sessionId, method, params) {
      const pending = cdp.sendSession(sessionId, method, params);
      if (method === 'Page.navigate') stopped = chrome.close();
      return pending;
    },
  };
  const devtools = createDevTools({
    cdp: client, endpoint: processInfo.endpoint, proxyAddress, version: processInfo.version,
    refuses: () => false, onCopy() {}, onChange() {}, onError(error) { throw error; },
  });
  context.after(() => devtools.dispose());
  await assert.rejects(devtools.open(targetId, { size: { width: 800, height: 600, scale: 1 } }), /Chrome|connection|closed|load/i);
  await stopped;
  assert.equal(devtools.page, null);
});
