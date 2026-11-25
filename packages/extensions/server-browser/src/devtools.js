// external: https://github.com/JosueGalRe/openchamber-server-browser/tree/v0.10.0 MIT frontend adaptation.
import crypto from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { createDevToolsPolicy } from './devtools-policy.js';
import { applyViewport } from './viewports.js';

const FRONTEND_ORIGIN = 'devtools://devtools';
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const MAX_BUFFERED_BYTES = 32 * 1024 * 1024;
const COPY_BINDING = 'openchamberDevtoolsCopy';
const contextSchema = z.object({ browserContextId: z.string().min(1) });
const targetSchema = z.object({ targetId: z.string().min(1) });
const FRONTEND_SCRIPT = `(() => {
  const setup = async () => {
    if (globalThis.openchamberDevtoolsReady) return;
    if (!document.querySelector('.root-view')) await new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        if (document.querySelector('.root-view')) { observer.disconnect(); resolve(); }
      });
      observer.observe(document, { childList: true, subtree: true });
    });
    const [legacy, host] = await Promise.all([import('./ui/legacy/legacy.js'), import('./core/host/host.js')]);
    legacy.ContextMenu.ContextMenu.useSoftMenu = true;
    const screencast = await import('./panels/screencast/screencast.js');
    const app = screencast.ScreencastApp.ScreencastApp.instance();
    app.toggleButton.setToggled(false);
    app.toggleButton.dispatchEventToListeners(legacy.Toolbar.ToolbarButton.Events.CLICK);
    const frontend = host.InspectorFrontendHost.InspectorFrontendHostInstance;
    frontend.copyText = (text) => globalThis.${COPY_BINDING}(String(text ?? ''));
    globalThis.openchamberDevtoolsReady = true;
  };
  if (document.readyState === 'complete') return setup();
  return new Promise((resolve, reject) => addEventListener('load', () => setup().then(resolve, reject), { once: true }));
})()`;

export const createDevTools = ({ cdp, endpoint, proxyAddress, version, refuses, onCopy, onChange, onError }) => {
  let current = null;
  let epoch = 0;
  let disposed = false;
  const reportFailure = (error) => { if (cdp.isOpen) onError(error); };
  const stopEvents = cdp.onEvent((event) => {
    const opening = current;
    if (!opening) return;
    if (event.method === 'Runtime.bindingCalled' && event.params.name === COPY_BINDING
      && event.sessionId === opening.page?.sessionId) onCopy(String(event.params.payload ?? ''));
    if (event.method === 'Target.targetDestroyed'
      && [opening.targetId, opening.page?.targetId].includes(event.params.targetId)) void close().catch(reportFailure);
    if (event.method === 'Target.targetCreated' && event.params.targetInfo?.type === 'page'
      && event.params.targetInfo.browserContextId === opening.contextId) {
      void opening.created.then((target) => {
        if (event.params.targetInfo.targetId !== target.targetId) {
          return cdp.send('Target.closeTarget', { targetId: event.params.targetInfo.targetId });
        }
        return undefined;
      }).catch(reportFailure);
    }
  });
  const cleanup = (opening) => opening.cleanup ??= (async () => {
    opening.link?.close();
    for (const client of opening.relay?.clients ?? []) client.terminate();
    const results = await Promise.allSettled([
      opening.relay ? new Promise((resolve) => opening.relay.close(resolve)) : Promise.resolve(),
      opening.contextId && cdp.isOpen
        ? cdp.send('Target.disposeBrowserContext', { browserContextId: opening.contextId }) : Promise.resolve(),
    ]);
    for (const result of results) if (result.status === 'rejected' && cdp.isOpen) throw result.reason;
  })();
  const close = async () => {
    const opening = current;
    if (!opening) return;
    current = null;
    epoch += 1;
    const changed = onChange();
    try {
      await Promise.all([opening.started, changed]);
    } finally {
      await cleanup(opening);
    }
  };
  const connect = (client, opening) => {
    opening.link?.close();
    const upstreamUrl = new URL(endpoint);
    upstreamUrl.pathname = `/devtools/page/${encodeURIComponent(opening.targetId)}`;
    upstreamUrl.search = '';
    const upstream = new WebSocket(upstreamUrl, {
      maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false, handshakeTimeout: 10_000,
    });
    const policy = createDevToolsPolicy({ targetId: opening.targetId, version, refuses });
    const queued = [];
    let queuedBytes = 0;
    const link = {
      close() {
        queued.length = 0;
        queuedBytes = 0;
        client.terminate();
        upstream.terminate();
      },
    };
    opening.link = link;
    const send = (socket, text) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount + Buffer.byteLength(text) > MAX_BUFFERED_BYTES) link.close();
      else socket.send(text);
    };
    client.on('message', (data, binary) => {
      try {
        const result = binary ? { ok: false } : policy.command(data.toString('utf8'));
        if (result.response) send(client, JSON.stringify(result.response));
        else if (!result.ok) link.close();
        else {
          const text = JSON.stringify(result.message);
          if (upstream.readyState !== WebSocket.CONNECTING) send(upstream, text);
          else {
            queuedBytes += Buffer.byteLength(text);
            if (queued.length >= 1024 || queuedBytes > MAX_BUFFERED_BYTES) link.close();
            else queued.push(text);
          }
        }
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        link.close();
      }
    });
    upstream.on('open', () => {
      for (const text of queued.splice(0)) send(upstream, text);
      queuedBytes = 0;
    });
    upstream.on('message', (data, binary) => {
      try {
        const result = binary ? { ok: false } : policy.event(data.toString('utf8'));
        if (result.ok) {
          if (result.message) send(client, JSON.stringify(result.message));
          if (result.command) send(upstream, JSON.stringify(result.command));
        }
        else link.close();
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        link.close();
      }
    });
    for (const socket of [client, upstream]) {
      socket.on('error', () => link.close());
      socket.on('close', () => link.close());
    }
  };
  return {
    get targetId() { return current?.ready ? current.targetId : null; },
    get page() { return current?.ready ? current.page : null; },
    get epoch() { return epoch; },
    async open(targetId, { size, colorScheme = 'system' }) {
      if (disposed) throw new Error('DevTools is disposed');
      await close();
      if (disposed) throw new Error('DevTools is disposed');
      const token = crypto.randomBytes(32).toString('hex');
      const opening = {
        targetId, contextId: null, page: null, ready: false, relay: null, link: null,
        created: null, started: null, cleanup: null,
      };
      current = opening;
      epoch += 1;
      const active = () => {
        if (current !== opening) throw new Error('DevTools closed while opening');
      };
      let finish;
      opening.started = new Promise((resolve) => { finish = resolve; });
      try {
        const relay = new WebSocketServer({
          host: '127.0.0.1', port: 0, maxPayload: MAX_MESSAGE_BYTES,
          perMessageDeflate: false,
          verifyClient: ({ origin, req }) => current === opening && origin === FRONTEND_ORIGIN
            && req.url === `/devtools/${token}` && req.headers.host === `127.0.0.1:${relay.address()?.port}`,
        });
        opening.relay = relay;
        relay.on('connection', (client) => connect(client, opening));
        await new Promise((resolve, reject) => {
          relay.once('error', reject);
          relay.once('listening', resolve);
        });
        active();
        const port = relay.address().port;
        const context = contextSchema.parse(await cdp.send('Target.createBrowserContext', {
          proxyServer: proxyAddress, proxyBypassList: `<-loopback>;127.0.0.1:${port}`,
        }));
        opening.contextId = context.browserContextId;
        active();
        opening.created = cdp.send('Target.createTarget', {
          url: 'about:blank', browserContextId: opening.contextId, newWindow: true, background: true,
        });
        const target = targetSchema.parse(await opening.created);
        active();
        const sessionId = await cdp.attach(target.targetId);
        opening.page = { cdp, sessionId, targetId: target.targetId, devtools: true };
        await cdp.sendSession(sessionId, 'Page.enable');
        await cdp.sendSession(sessionId, 'Runtime.enable');
        await cdp.sendSession(sessionId, 'Runtime.addBinding', { name: COPY_BINDING });
        await cdp.sendSession(sessionId, 'Page.addScriptToEvaluateOnNewDocument', { source: FRONTEND_SCRIPT });
        await applyViewport(cdp, sessionId, { ...size, mobile: false });
        if (colorScheme !== 'system') {
          await cdp.sendSession(sessionId, 'Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: colorScheme }] });
        }
        let stopLoad;
        const loaded = new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Chrome DevTools frontend did not load')), 10_000);
          const stopClose = cdp.onClose(() => reject(new Error('Chrome closed while loading DevTools')));
          const stopEvent = cdp.onEvent((event) => {
            if (event.sessionId === sessionId && event.method === 'Page.loadEventFired') resolve();
          });
          stopLoad = () => { clearTimeout(timer); stopClose(); stopEvent(); };
        });
        try {
          await Promise.all([loaded, cdp.sendSession(sessionId, 'Page.navigate', {
            url: `devtools://devtools/bundled/inspector.html?ws=127.0.0.1:${port}/devtools/${token}`,
          })]);
        } finally {
          stopLoad();
        }
        const setup = await cdp.sendSession(sessionId, 'Runtime.evaluate', { expression: FRONTEND_SCRIPT, awaitPromise: true });
        if (setup.exceptionDetails) throw new Error(`Chrome DevTools frontend setup failed: ${setup.exceptionDetails.exception?.description?.split('\n')[0] ?? setup.exceptionDetails.text}`);
        active();
        opening.ready = true;
        await onChange();
        return opening.page;
      } catch (error) {
        if (current === opening) { current = null; epoch += 1; }
        await cleanup(opening);
        throw error;
      } finally {
        finish();
      }
    },
    close,
    resize(size) {
      return current?.page ? applyViewport(cdp, current.page.sessionId, { ...size, mobile: false }) : Promise.resolve();
    },
    async dispose() {
      disposed = true;
      stopEvents();
      await close();
    },
  };
};
