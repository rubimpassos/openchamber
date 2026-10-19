import { describe, expect, it, vi } from 'vitest';
import { createJevClient, parseRetryAfterMs } from './jev.js';

const ENDPOINT = { url: 'https://opencode.ai/zen/v1/systemone', model: 'jev-1.13-free', headers: {} };

const rateLimited = (retryAfter) => new Response(
  JSON.stringify({ type: 'error', error: { type: 'FreeUsageLimitError', message: 'Rate limit exceeded.' } }),
  { status: 429, headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter } },
);

const makeClient = (responses) => {
  let clock = 1_000_000;
  const log = { warn: vi.fn() };
  const fetchImpl = vi.fn(async () => responses.shift());
  const client = createJevClient({ fetchImpl, now: () => clock, log });
  return { client, fetchImpl, log, advance: (ms) => { clock += ms; } };
};

describe('Jev client rate limits', () => {
  it('reads Retry-After as seconds or a date', () => {
    expect(parseRetryAfterMs('2433', 0)).toBe(2_433_000);
    expect(parseRetryAfterMs(new Date(60_000).toUTCString(), 0)).toBe(60_000);
    expect(parseRetryAfterMs(undefined, 0)).toBeNull();
    expect(parseRetryAfterMs('soon', 0)).toBeNull();
  });

  it('names the provider error and the wait, then calls nothing until the wait is over', async () => {
    const { client, fetchImpl, log, advance } = makeClient([
      rateLimited('120'),
      Response.json({ answers: { probe: { choice: 'blue', confidence: 1 } } }),
    ]);

    await expect(client.ask({}, ENDPOINT)).rejects.toMatchObject({
      message: 'Jev responded 429 (FreeUsageLimitError, retry in 2 min)',
      status: 429,
      type: 'FreeUsageLimitError',
      retryAfterMs: 120_000,
    });
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toContain('opencode.ai is rate limiting (FreeUsageLimitError)');

    await expect(client.ask({}, ENDPOINT)).rejects.toMatchObject({ code: 'rate-limited', retryAfterMs: 120_000 });
    expect(client.pausedUntil(ENDPOINT)).not.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    advance(120_001);
    await expect(client.ask({}, ENDPOINT)).resolves.toMatchObject({ answers: { probe: { choice: 'blue' } } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it('pauses only the endpoint and model that answered 429', async () => {
    const { client } = makeClient([rateLimited('60')]);
    await expect(client.ask({}, ENDPOINT)).rejects.toMatchObject({ status: 429 });
    expect(client.pausedUntil({ ...ENDPOINT, model: 'jev-1.13' })).toBeNull();
  });

  it('does not pause on a 429 without Retry-After', async () => {
    const { client, fetchImpl } = makeClient([rateLimited(undefined), rateLimited(undefined)]);
    await expect(client.ask({}, ENDPOINT)).rejects.toMatchObject({ status: 429, retryAfterMs: null });
    await expect(client.ask({}, ENDPOINT)).rejects.toMatchObject({ status: 429 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
