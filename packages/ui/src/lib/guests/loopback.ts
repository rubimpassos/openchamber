import {
  GUEST_LOOPBACK_RESPONSE_BYTES, HOST_REQUEST_ERROR_CODES, HostRequestError, matchLoopbackRoute,
  type LoopbackRequest, type LoopbackRequestResult, type LoopbackUrlRequest, type LoopbackUrlResult,
} from '@openchamber/sdk';
import { z } from 'zod';

import { mintGuestFrameUrlAuthToken } from '@/lib/runtime-auth';
import { runtimeFetch, type RuntimeFetchOptions } from '@/lib/runtime-fetch';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { guestMay } from './capabilities';
import type { InstalledGuest } from './types';

type FrameOwner = {
  readonly guestId: string;
  readonly currentGuest: () => InstalledGuest | null;
  readonly isCurrent: () => boolean;
  readonly signal: AbortSignal;
  readonly transport: 'url' | 'document';
};
type LoopbackRuntime = {
  readonly key: typeof getRuntimeKey;
  readonly mint: typeof mintGuestFrameUrlAuthToken;
  readonly fetch: typeof runtimeFetch;
  readonly resolver: typeof getRuntimeUrlResolver;
};
const runtime: LoopbackRuntime = {
  key: getRuntimeKey, mint: mintGuestFrameUrlAuthToken, fetch: runtimeFetch, resolver: getRuntimeUrlResolver,
};
const failureSchema = z.object({ error: z.enum(HOST_REQUEST_ERROR_CODES), message: z.string() });

/** SDK schemas already admitted the payload. Identity and approval belong to the parent, never the payload. */
export const createGuestLoopback = (owner: FrameOwner, transport: LoopbackRuntime = runtime) => {
  const runtimeKey = transport.key();
  const authorize = (request: LoopbackUrlRequest, method: LoopbackRequest['method']): string => {
    if (!owner.isCurrent() || owner.signal.aborted || transport.key() !== runtimeKey) {
      throw new HostRequestError('HOST_UNAVAILABLE', 'Extension frame owner changed.');
    }
    const guest = owner.currentGuest();
    if (!guest || guest.id !== owner.guestId || !guestMay(guest, 'loopback')
      || guest.enterpriseBlocked?.includes('loopback')) {
      throw new HostRequestError('NOT_GRANTED', 'Loopback access is not approved.');
    }
    if (!guest.loopback || guest.loopback.status !== 'ready') {
      throw new HostRequestError('HOST_REJECTED', 'Loopback configuration is unavailable.');
    }
    const path = matchLoopbackRoute(guest.loopback.routes, request.path, method);
    if (path === null) throw new HostRequestError('NOT_GRANTED', 'Loopback route is not approved.');
    return `/api/guests/${owner.guestId}/loopback${path}`;
  };
  const loopbackUrl = async (request: LoopbackUrlRequest): Promise<LoopbackUrlResult> => {
    const path = authorize(request, 'GET');
    if (owner.transport === 'document') throw new HostRequestError('UNSUPPORTED', 'Relay frames require parent-mediated loopback requests.');
    try {
      const { token, expiresAt } = await transport.mint(owner.guestId);
      authorize(request, 'GET');
      const asset = transport.resolver().assetWithUrlToken(path, token, request.query);
      const url = URL.canParse(asset) ? asset : new URL(asset, window.location.href).href;
      return { url, expiresAt };
    } catch (error) {
      authorize(request, 'GET');
      if (error instanceof HostRequestError) throw error;
      throw new HostRequestError('DISCONNECTED', 'Could not authorize loopback access.');
    }
  };
  const loopbackRequest = async (request: LoopbackRequest): Promise<LoopbackRequestResult> => {
    const path = authorize(request, request.method);
    const signal = AbortSignal.any([owner.signal, AbortSignal.timeout(15_000)]);
    try {
      const options: RuntimeFetchOptions = { method: request.method, query: request.query, signal };
      if (request.method === 'POST') {
        options.headers = { 'Content-Type': 'application/json' };
        if (request.body !== undefined) options.body = JSON.stringify(request.body);
      }
      const response = await transport.fetch(path, options);
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let body = '';
      let bytes = 0;
      try {
        authorize(request, request.method);
        if (reader) {
          while (true) {
            const chunk = await reader.read();
            authorize(request, request.method);
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > GUEST_LOOPBACK_RESPONSE_BYTES) throw new HostRequestError('HOST_REJECTED', 'Loopback response exceeds 16 MiB.');
            body += decoder.decode(chunk.value, { stream: true });
          }
        }
        body += decoder.decode();
      } finally {
        await reader?.cancel();
        reader?.releaseLock();
      }
      authorize(request, request.method);
      // The proxy's typed refusals are not application payloads. Other HTTP errors retain their status and text.
      if (!response.ok) {
        try {
          const failure = failureSchema.safeParse(JSON.parse(body));
          if (failure.success) throw new HostRequestError(failure.data.error, failure.data.message);
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
        }
      }
      return { status: response.status, body };
    } catch (error) {
      authorize(request, request.method);
      if (error instanceof HostRequestError) throw error;
      if (signal.aborted) throw new HostRequestError('HOST_TIMEOUT', 'Loopback request timed out.');
      throw new HostRequestError('DISCONNECTED', 'Loopback transport failed.');
    }
  };
  return { loopbackUrl, loopbackRequest };
};
