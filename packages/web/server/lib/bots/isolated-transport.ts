import { BotServiceError } from './services/contracts.js';
import { z } from 'zod';
import { createBotArtifactTransport } from '../agent-server/bot-artifact-services.js';
import { BOT_ARTIFACT_SPACE_ROUTE } from '../agent-server/bot-artifact-service-contract.js';
import type { IsolatedSpacesHost } from './isolated-stages.types.js';
import type { InsideResponse } from '../spaces/dispatcher.js';

export const botSpaceFetch = (host: IsolatedSpacesHost, spaceId: string) => async (
  input: string | URL | Request, init?: Omit<RequestInit, 'body'> & { readonly body?: BodyInit | null | undefined },
) => {
  const { body, ...options } = init ?? {};
  const request = new Request(input, body === undefined ? options : { ...options, body });
  const url = new URL(request.url);
  const headers = Object.fromEntries(request.headers);
  for (const name of ['authorization', 'cookie', 'proxy-authorization', 'host', 'origin', 'referer']) delete headers[name];
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]);
  signal.throwIfAborted();
  const pending = host.dispatcher.requestInside(spaceId, { method: request.method, path: url.pathname + url.search,
    headers, body: ['GET', 'HEAD'].includes(request.method) ? null : Buffer.from(await request.arrayBuffer()), timeoutMs: 30_000 });
  let response: InsideResponse | undefined;
  const abort = () => response?.destroy();
  signal.addEventListener('abort', abort, { once: true });
  try {
    response = await pending;
    signal.throwIfAborted();
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of response) {
      signal.throwIfAborted(); bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) throw new BotServiceError('BOT_ISOLATED_RESPONSE_TOO_LARGE', 'Isolated bot response exceeds its byte limit');
      chunks.push(chunk);
    }
    if (!response.complete) throw new BotServiceError('BOT_ISOLATED_RESPONSE_INCOMPLETE', 'Isolated bot response is incomplete');
    const status = response.statusCode;
    if (status < 200 || status >= 300) throw new BotServiceError('BOT_ISOLATED_REQUEST_FAILED', 'The recorded isolated bot request failed.');
    return new Response([204, 205].includes(status) ? null : Buffer.concat(chunks), { status, headers: { 'content-type': 'application/json' } });
  } finally { signal.removeEventListener('abort', abort); response?.destroy(); }
};

export function botSpaceArtifactTransport(host: IsolatedSpacesHost, spaceId: string) {
  const fetchImpl = botSpaceFetch(host, spaceId);
  return createBotArtifactTransport({ request: async (operation, body, signal) =>
    z.json().parse(await (await fetchImpl(`http://space.invalid${BOT_ARTIFACT_SPACE_ROUTE}/${operation}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body, signal,
    })).json()) });
}
