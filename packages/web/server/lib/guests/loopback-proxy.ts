import http from 'node:http';
import type { ClientRequest, IncomingMessage, OutgoingHttpHeaders } from 'node:http';
import type { LoopbackMethod } from '@openchamber/sdk';
import type { Response } from '../shared/http-contracts.js';
import { GUEST_LOOPBACK_RESPONSE_BYTES } from '@openchamber/sdk';
import { LoopbackError, sendLoopbackError } from './loopback-policy.js';

export const LOOPBACK_TIMING = Object.freeze({ headersMs: 5_000, finiteMs: 15_000, leaseMs: 60_000 });
export const LOOPBACK_CLOCK = Object.freeze({ setTimeout, clearTimeout });

export type LoopbackClock = typeof LOOPBACK_CLOCK;
export type LoopbackTiming = Readonly<{ headersMs: number; finiteMs: number; leaseMs: number }>;
type LoopbackProxyRequest = {
  readonly port: number;
  readonly path: string;
  readonly method: LoopbackMethod;
  readonly accept: string;
  readonly body?: string | undefined;
};
type LoopbackProxyOptions = {
  readonly signal: AbortSignal;
  readonly clock?: LoopbackClock;
  readonly timing?: LoopbackTiming;
};

export const proxyLoopbackRequest = (res: Response, request: LoopbackProxyRequest, { signal, clock = LOOPBACK_CLOCK, timing = LOOPBACK_TIMING }: LoopbackProxyOptions): Promise<void> => new Promise((resolve) => {
  let upstream: ClientRequest | null = null;
  let incoming: IncomingMessage | undefined;
  let finished = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const clearTimer = (timer: ReturnType<typeof setTimeout>) => {
    clock.clearTimeout(timer);
    timers.delete(timer);
  };
  const finish = (cause?: unknown) => {
    if (finished) return;
    finished = true;
    for (const timer of timers) clock.clearTimeout(timer);
    timers.clear();
    signal.removeEventListener('abort', onAbort);
    res.off('close', onClose);
    res.off('finish', onClose);
    incoming?.destroy();
    upstream?.destroy();
    if (cause) sendLoopbackError(res, cause);
    resolve();
  };
  const onClose = () => finish();
  const onAbort = () => finish(signal.reason);
  const deadline = (milliseconds: number, message: string) => {
    const timer = clock.setTimeout(() => finish(new LoopbackError(504, 'HOST_TIMEOUT', message)), milliseconds);
    timers.add(timer);
    return timer;
  };
  res.once('close', onClose);
  res.once('finish', onClose);
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) { onAbort(); return; }
  const headerTimer = deadline(timing.headersMs, 'Loopback connection timed out.');
  const finiteTimer = deadline(timing.finiteMs, 'Loopback response timed out.');
  const headers: OutgoingHttpHeaders = { Host: `127.0.0.1:${request.port}`, Accept: request.accept };
  if (request.method === 'POST') headers['Content-Type'] = 'application/json';
  if (request.body !== undefined) headers['Content-Length'] = Buffer.byteLength(request.body);
  upstream = http.request({
    hostname: '127.0.0.1', port: request.port, method: request.method,
    path: request.path, headers, agent: false,
  });
  upstream.once('error', () => finish(new LoopbackError(502, 'HOST_UNAVAILABLE', 'Loopback service is unavailable.')));
  upstream.once('upgrade', (_response, socket) => {
    socket.destroy();
    finish(new LoopbackError(502, 'HOST_REJECTED', 'Loopback upgrades are not supported.'));
  });
  upstream.once('response', (response) => {
    incoming = response;
    if (finished) { response.destroy(); return; }
    clearTimer(headerTimer);
    const status = response.statusCode ?? 502;
    const contentType = response.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
    const encoding = response.headers['content-encoding'];
    if (status >= 300 && status < 400) {
      finish(new LoopbackError(502, 'HOST_REJECTED', 'Loopback redirects are not supported.'));
      return;
    }
    if (contentType === undefined || !['application/json', 'text/plain', 'text/event-stream'].includes(contentType)
      || (encoding && encoding !== 'identity')) {
      finish(new LoopbackError(502, 'HOST_REJECTED', 'Unsupported loopback response type.'));
      return;
    }
    response.once('error', () => finish(new LoopbackError(502, 'HOST_UNAVAILABLE', 'Loopback response interrupted.')));
    if (contentType === 'text/event-stream' && request.method !== 'HEAD') {
      clearTimer(finiteTimer);
      deadline(timing.leaseMs, 'Loopback stream lease expired.');
      res.status(status).set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();
      response.pipe(res);
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    response.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > GUEST_LOOPBACK_RESPONSE_BYTES) {
        finish(new LoopbackError(502, 'HOST_REJECTED', 'Loopback response exceeds 16 MiB.'));
        return;
      }
      chunks.push(chunk);
    });
    response.once('end', () => {
      if (finished) return;
      res.status(status).set('Content-Type', `${contentType}; charset=utf-8`).end(Buffer.concat(chunks));
    });
  });
  upstream.end(request.body);
});
