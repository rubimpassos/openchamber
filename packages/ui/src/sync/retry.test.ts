import { describe, expect, test } from 'bun:test';

import { ClientError } from '@opencode/client';
import { normalizeOpencodeError } from '@/lib/opencode/client';
import { retry } from './retry';

describe('retry transient classification (#2470)', () => {
  test("'terminated' (undici half-open socket teardown) is retried", async () => {
    let attempts = 0;
    await expect(
      retry(async () => {
        attempts += 1;
        throw new TypeError('terminated');
      }),
    ).rejects.toThrow('terminated');
    expect(attempts).toBe(3);
  });

  test("normalized 'request timed out' (SDK read timeout) is retried", async () => {
    let attempts = 0;
    await expect(
      retry(async () => {
        attempts += 1;
        throw new Error('OpenCode request timed out after 30000ms');
      }),
    ).rejects.toThrow('request timed out');
    expect(attempts).toBe(3);
  });

  test('an SDK read that lost its connection is retried until it answers', async () => {
    let attempts = 0;
    const page = await retry(async () => {
      attempts += 1;
      if (attempts < 3) {
        throw normalizeOpencodeError('message.list', new ClientError('Transport', { cause: new Error('relay tunnel reset: relay keepalive timeout') }));
      }
      return 'page';
    }, { delay: 1 });
    expect(page).toBe('page');
    expect(attempts).toBe(3);
  });

  test('an SDK read the caller aborted is NOT retried', async () => {
    let attempts = 0;
    await expect(
      retry(async () => {
        attempts += 1;
        throw normalizeOpencodeError('message.list', new ClientError('Transport', { cause: new DOMException('Aborted', 'AbortError') }));
      }),
    ).rejects.toThrow('transport failure');
    expect(attempts).toBe(1);
  });

  test('caller-initiated abort (AbortError) is NOT retried', async () => {
    let attempts = 0;
    await expect(
      retry(async () => {
        attempts += 1;
        throw new DOMException('Aborted', 'AbortError');
      }),
    ).rejects.toThrow('Aborted');
    expect(attempts).toBe(1);
  });
});

describe('retry cancellation', () => {
  test('cancels the backoff and makes no later attempt when its owner aborts', async () => {
    const controller = new AbortController();
    let notifyRetry: () => void;
    const retrying = new Promise<void>((resolve) => { notifyRetry = resolve; });
    let attempts = 0;
    const run = retry(async () => {
      attempts += 1;
      throw new Error('Temporary failure');
    }, {
      delay: 10_000,
      signal: controller.signal,
      retryIf: () => { notifyRetry(); return true; },
    });
    await retrying;
    controller.abort(new Error('Recovery owner left'));
    await expect(run).rejects.toThrow('Recovery owner left');
    expect(attempts).toBe(1);
  });

  test('does not start a request for an already aborted owner', async () => {
    const controller = new AbortController();
    controller.abort(new Error('Recovery owner already left'));
    let attempts = 0;
    await expect(retry(async () => { attempts += 1; }, { signal: controller.signal }))
      .rejects.toThrow('Recovery owner already left');
    expect(attempts).toBe(0);
  });
});
