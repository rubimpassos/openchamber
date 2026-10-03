import type { GuestLoopbackRequestMessage, GuestLoopbackUrlMessage, HostResultPayload } from './contract.ts';
import { HostRequestError } from './host-errors.ts';
import {
  canonicalizeLoopbackPath, isLoopbackBody, isLoopbackQuery, isLoopbackRequestResult, isLoopbackUrlResult,
  type LoopbackRequest, type LoopbackRequestResult, type LoopbackUrlRequest, type LoopbackUrlResult,
} from './loopback.ts';
import { watchLoopback, type LoopbackWatchEvent, type LoopbackWatchRuntime } from './loopback-watch.ts';

export type LoopbackClient = {
  readonly loopbackUrl: (request: LoopbackUrlRequest) => Promise<LoopbackUrlResult>;
  readonly loopbackRequest: (request: LoopbackRequest) => Promise<LoopbackRequestResult>;
  readonly watchLoopback: (request: LoopbackUrlRequest, listener: (event: LoopbackWatchEvent) => void) => () => void;
};
type LoopbackCall = Pick<GuestLoopbackRequestMessage, 'type' | 'payload'> | Pick<GuestLoopbackUrlMessage, 'type' | 'payload'>;
type LoopbackTransport = {
  readonly send: (message: LoopbackCall) => Promise<HostResultPayload | undefined>;
  readonly signal: AbortSignal;
};

// Exhaustiveness proof for typed callers; a JavaScript caller gets a typed refusal.
const assertNever = (request: never): never => {
  void request;
  throw new HostRequestError('HOST_REJECTED', 'Unsupported loopback method.');
};

const admit = (request: LoopbackUrlRequest): LoopbackUrlRequest => {
  const path = canonicalizeLoopbackPath(request.path);
  if (path === null) throw new HostRequestError('BAD_PATH', 'Invalid loopback pathname.');
  if (!isLoopbackQuery(request.query)) throw new HostRequestError('BAD_PATH', 'Invalid loopback query.');
  return request.query === undefined ? { path } : { path, query: { ...request.query } };
};

/** Uses the host client's existing RPC timeout and disposal, never a second bridge. */
export const createLoopbackClient = (transport: LoopbackTransport, runtime?: LoopbackWatchRuntime): LoopbackClient => {
  const loopbackUrl = async (request: LoopbackUrlRequest): Promise<LoopbackUrlResult> => {
    const result = await transport.send({ type: 'loopback-url', payload: admit(request) });
    if (!isLoopbackUrlResult(result)) throw new HostRequestError('HOST_REJECTED', 'Invalid loopback URL result.');
    return result;
  };
  return {
    loopbackUrl,
    loopbackRequest: async (request) => {
      const target = admit(request);
      let payload: LoopbackRequest;
      switch (request.method) {
        case 'GET':
        case 'HEAD':
          if (request.body !== undefined) throw new HostRequestError('HOST_REJECTED', 'Only POST accepts a JSON body.');
          payload = { ...target, method: request.method };
          break;
        case 'POST':
          if (request.body !== undefined && !isLoopbackBody(request.body)) {
            throw new HostRequestError('HOST_REJECTED', 'Loopback body must be JSON of at most 64 KiB.');
          }
          payload = request.body === undefined ? { ...target, method: 'POST' } : { ...target, method: 'POST', body: request.body };
          break;
        default: return assertNever(request);
      }
      const result = await transport.send({ type: 'loopback-request', payload });
      if (!isLoopbackRequestResult(result)) throw new HostRequestError('HOST_REJECTED', 'Invalid loopback request result.');
      return result;
    },
    watchLoopback: (request, listener) => {
      if (transport.signal.aborted) throw new HostRequestError('HOST_UNAVAILABLE', 'Host client was disposed.');
      const target = admit(request);
      return watchLoopback({ mint: () => loopbackUrl(target), signal: transport.signal }, listener, runtime);
    },
  };
};
