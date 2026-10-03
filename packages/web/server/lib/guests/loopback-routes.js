import express from 'express';
import { GUEST_LOOPBACK_BODY_BYTES, GUEST_LOOPBACK_QUERY_BYTES } from '@openchamber/sdk';
import { createRequestSecurityRuntime } from '../security/request-security.js';
import { LoopbackError, sendLoopbackError } from './loopback-policy.js';
import { proxyLoopbackRequest, LOOPBACK_CLOCK, LOOPBACK_TIMING } from './loopback-proxy.js';
import { createLoopbackRuntime } from './loopback-runtime.js';

const defaultSecurity = createRequestSecurityRuntime({ readSettingsFromDiskMigrated: async () => ({}) });
const jsonBody = express.json({ limit: GUEST_LOOPBACK_BODY_BYTES, strict: false });

export const registerLoopbackRoutes = (app, {
  persistPath, isRequestOriginAllowed = defaultSecurity.isRequestOriginAllowed,
  clock = LOOPBACK_CLOCK, timing = LOOPBACK_TIMING,
}) => {
  const runtime = createLoopbackRuntime(persistPath, clock);
  // A prefix middleware retains the RAW tail in req.url, unlike decoded wildcard params.
  // Every method and refusal ends here, never in the guest static wildcard.
  app.use('/api/guests/:id/loopback', async (req, res) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; frame-ancestors 'none'", 'Cache-Control': 'no-store' });
    res.removeHeader('Access-Control-Allow-Credentials');
    if (req.method === 'GET' || req.method === 'HEAD') res.set('Access-Control-Allow-Origin', 'null');
    let lease;
    const close = () => lease?.close();
    const abort = () => sendLoopbackError(res, lease.signal.reason);
    res.once('close', close);
    try {
      switch (req.method) {
        case 'GET': case 'HEAD': case 'POST': break;
        default:
          res.set('Allow', 'GET, HEAD, POST');
          throw new LoopbackError(405, 'HOST_REJECTED', 'Unsupported loopback method.');
      }
      const separator = req.url.indexOf('?');
      const path = separator < 0 ? req.url : req.url.slice(0, separator);
      const rawQuery = separator < 0 ? '' : req.url.slice(separator + 1);
      if (Buffer.byteLength(rawQuery) > GUEST_LOOPBACK_QUERY_BYTES) {
        throw new LoopbackError(400, 'BAD_PATH', 'Loopback query exceeds 2 KiB.');
      }
      try {
        decodeURIComponent(rawQuery);
      } catch (error) {
        if (!(error instanceof URIError)) throw error;
        throw new LoopbackError(400, 'BAD_PATH', 'Invalid loopback query encoding.');
      }
      const query = new URLSearchParams(rawQuery);
      if (req.method === 'POST') {
        if (query.has('oc_url_token')) throw new LoopbackError(403, 'NOT_GRANTED', 'URL tokens cannot authorize writes.');
        if (req.headers.origin === 'null' || req.headers['sec-fetch-site'] === 'cross-site'
          || (req.headers.origin !== undefined && !await isRequestOriginAllowed(req))) {
          throw new LoopbackError(403, 'DENIED', 'Cross-origin loopback writes are not allowed.');
        }
        if (!req.is('application/json')) throw new LoopbackError(400, 'HOST_REJECTED', 'Loopback writes require JSON.');
        // Also works behind an existing global JSON parser: Express skips a consumed body.
        await new Promise((resolve, reject) => jsonBody(req, res, (error) => {
          if (!error) { resolve(); return; }
          reject(new LoopbackError(error.status === 413 ? 413 : 400, 'HOST_REJECTED', 'Invalid loopback JSON body.'));
        }));
      } else if (req.body !== undefined || req.headers['transfer-encoding'] || Number(req.headers['content-length']) > 0) {
        throw new LoopbackError(400, 'HOST_REJECTED', 'Loopback reads cannot carry a body.');
      }
      const body = req.method === 'POST' && req.body !== undefined ? JSON.stringify(req.body) : undefined;
      if (body !== undefined && Buffer.byteLength(body) > GUEST_LOOPBACK_BODY_BYTES) {
        throw new LoopbackError(413, 'HOST_REJECTED', 'Loopback JSON body exceeds 64 KiB.');
      }
      for (const key of [...query.keys()]) if (key.startsWith('oc_')) query.delete(key);
      const search = query.toString();
      if (search.length > GUEST_LOOPBACK_QUERY_BYTES) throw new LoopbackError(400, 'BAD_PATH', 'Loopback query exceeds 2 KiB.');
      lease = runtime.open({ guestId: req.params.id, path, method: req.method });
      lease.signal.addEventListener('abort', abort, { once: true });
      const target = await lease.authorize();
      if (res.destroyed || res.writableEnded) return;
      lease.signal.removeEventListener('abort', abort);
      await proxyLoopbackRequest(res, {
        port: target.port, path: `${target.path}${search ? `?${search}` : ''}`,
        method: req.method, body, accept: req.get('accept') ?? '*/*',
      }, { signal: lease.signal, clock, timing });
    } catch (error) {
      sendLoopbackError(res, error);
    } finally {
      res.off('close', close);
      lease?.signal.removeEventListener('abort', abort);
      lease?.close();
    }
  });
  return runtime;
};
