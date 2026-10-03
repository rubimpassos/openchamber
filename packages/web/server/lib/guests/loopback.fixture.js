import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import express from 'express';
import compression from 'compression';
import { createUiAuth } from '../ui-auth/ui-auth.js';
import { registerLoopbackRoutes } from './loopback-routes.js';
import { registerGuestRoutes } from './routes.js';
import { guestGrantScope } from './grant-scope.js';
import { writeExtensionStore } from './persist.js';
import { invalidateGuestCatalog } from './catalog.js';

export const listen = async (handler) => {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
};

const openHttp = (port, target, options = {}) => new Promise((resolve, reject) => {
  const req = http.request({ hostname: '127.0.0.1', port, path: target, agent: false,
    method: options.method ?? 'GET', headers: options.headers ?? {} }, resolve);
  req.once('error', reject);
  req.end(options.body);
});

export const readHttp = async (port, target, options) => {
  const response = await openHttp(port, target, options);
  const chunks = [];
  for await (const chunk of response) chunks.push(chunk);
  return { status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString() };
};

export const createLoopbackFixture = async ({ password = 'fixture-password', clock, timing, globalParser = true } = {}) => {
  const root = await fs.mkdtemp('/tmp/opencode/oc-loopback-http-');
  const persistPath = path.join(root, 'extensions.json');
  const packageRoot = path.join(root, 'package');
  await fs.mkdir(packageRoot);
  await fs.writeFile(path.join(packageRoot, 'index.html'), '<p>Fixture</p>');
  const requests = [];
  let handler = (_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true}'); };
  const upstream = await listen((req, res) => { requests.push(req); handler(req, res); });
  const port = upstream.address().port;
  const contribution = { port, env: 'OC_TRANSPORT_TEST_PORT', routes: [
    { path: '/panel/state', methods: ['GET', 'HEAD'] },
    { path: '/panel/events', methods: ['GET'] },
    { path: '/sessions/*/enabled', methods: ['POST'] },
  ] };
  const manifest = { version: '1.0.0', openchamber: { apiVersion: 1, contributes: {
    panel: { id: 'local-api', name: 'Local API', icon: 'plug', entry: 'index.html' }, loopback: contribution,
  } } };
  const saveManifest = () => fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify(manifest));
  await saveManifest();
  const store = { paths: [packageRoot], capabilityGrants: { 'local-api': ['loopback'] },
    capabilityScopes: { 'local-api': guestGrantScope({ loopback: contribution }) } };
  const saveStore = () => writeExtensionStore(persistPath, store);
  await saveStore();
  const auth = createUiAuth({ password });
  const app = express();
  app.use(compression({ threshold: 0 }));
  if (globalParser) app.use(express.json({ limit: '1mb', strict: false }));
  app.post('/auth/session', express.json(), auth.handleSessionCreate);
  app.post('/auth/url-token', express.json(), auth.handleUrlAuthToken);
  app.use(auth.requireAuth);
  // Inject only time. Policy, store, parser, auth and both HTTP legs are real.
  const runtime = clock || timing
    ? registerLoopbackRoutes(app, { persistPath, clock, timing })
    : registerGuestRoutes(app, { openchamberDataDir: root, openchamberVersion: '2.1.1', resolveGitBinaryForSpawn: () => 'git' });
  const server = await listen(app);
  const serverPort = server.address().port;
  const base = '/api/guests/local-api/loopback';
  const login = password ? await readHttp(serverPort, '/auth/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
  }) : null;
  const cookie = login?.headers['set-cookie']?.[0].split(';')[0];
  const credentials = cookie ? { Cookie: cookie } : {};
  const read = (target, options = {}) => readHttp(serverPort, `${base}${target}`, {
    ...options, headers: { ...credentials, ...options.headers },
  });
  const open = (target = '/panel/events', options = {}) => openHttp(serverPort, `${base}${target}`, {
    ...options, headers: { ...credentials, ...options.headers },
  });
  return {
    root, port, serverPort, base, manifest, store, requests, runtime, saveStore, saveManifest, read, open,
    respond: (next) => { handler = next; },
    mint: async () => {
      const result = await readHttp(serverPort, '/auth/url-token', { method: 'POST', headers: {
        ...credentials, 'Content-Type': 'application/json',
      }, body: JSON.stringify({ scope: 'guest:local-api' }) });
      return JSON.parse(result.text).token;
    },
    async dispose() {
      runtime.dispose();
      auth.dispose();
      for (const listener of [server, upstream]) {
        listener.closeAllConnections();
        await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
      }
      invalidateGuestCatalog(persistPath);
      await fs.rm(root, { recursive: true, force: true });
    },
  };
};

/** A deterministic clock for transport deadlines, without faking Node sockets. */
export const createLoopbackClock = () => {
  let now = 0;
  const timers = new Map();
  return {
    setTimeout(fn, delay) { const id = Symbol(); timers.set(id, { at: now + delay, fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    async advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now && timers.delete(id)) await timer.fn();
      }
    },
  };
};
