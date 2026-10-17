import { describe, expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createTokenSnapshotReader } from './token-usage.js';

const assistant = (created, overrides = {}) => ({
  id: `msg_${created}`,
  type: 'assistant',
  time: { created, completed: created + 1 },
  tokens: { input: 10, output: 5, reasoning: 3, cache: { read: 7, write: 2 } },
  ...overrides,
});
const page = (data, next) => ({ data, cursor: next ? { next } : {} });
const fullPage = (start) => Array.from({ length: 100 }, (_, index) => assistant(start - index));

// Drive the adapter over real HTTP, with an isolated ephemeral port per test.
const readPages = async (pages, options = { since: 0 }) => {
  const requests = [];
  const server = createServer(async (request, response) => {
    requests.push({ url: new URL(request.url, 'http://127.0.0.1'), headers: new Headers(request.headers) });
    const body = pages[requests.length - 1];
    const result = body instanceof Response ? body : Response.json(body ?? { error: 'Unexpected page' });
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(await result.text());
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  try {
    const reader = createTokenSnapshotReader({
      buildOpenCodeUrl: (route) => new URL(route, `http://127.0.0.1:${address.port}`).href,
      getOpenCodeAuthHeaders: () => ({ Authorization: 'Basic test-only' }),
    });
    const total = await reader('ses_test/a', '/repo with spaces/ç', options);
    return { total, requests };
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
};

describe('completed assistant token snapshots', () => {
  test('sums all five usage fields across multiple cursor pages', async () => {
    // Given two full pages and a short final page with a terminal next cursor.
    const pages = [page(fullPage(300), 'older-1'), page(fullPage(200), 'older-2'), page([assistant(100)], 'terminal')];
    // When the snapshot walks the session history.
    const { total, requests } = await readPages(pages);
    // Then every completed step counts once, with scoped authenticated requests.
    expect(total).toBe(201 * 27);
    expect(requests.map(({ url }) => url.searchParams.get('cursor'))).toEqual([null, 'older-1', 'older-2']);
    for (const { url, headers } of requests) {
      expect(url.pathname).toBe('/api/session/ses_test%2Fa/message');
      expect([...url.searchParams.keys()].sort()).toEqual(url.searchParams.has('cursor') ? ['cursor', 'limit'] : ['limit']);
      expect(url.searchParams.get('limit')).toBe('100');
      expect(headers.get('authorization')).toBe('Basic test-only');
      expect(headers.get('x-opencode-directory')).toBe(encodeURIComponent('/repo with spaces/ç'));
    }
  });

  test('counts tool-call steps but excludes unfinished assistants and non-assistant usage', async () => {
    // Given completed tool and final steps, an unfinished step and a compaction request.
    const messages = [
      assistant(6, { time: { created: 6 } }),
      assistant(5, { finish: 'stop' }),
      assistant(4, { finish: 'tool-calls' }),
      assistant(3, { type: 'compaction', status: 'completed' }),
      { id: 'msg_user', type: 'user', time: { created: 2 } },
    ];
    // When completed usage is read.
    const { total } = await readPages([page(messages)]);
    // Then both completed assistant steps count, regardless of finish reason.
    expect(total).toBe(54);
  });

  test('retains earlier assistant usage across a compaction marker', async () => {
    // Given an older step retained after compaction and a smaller new context.
    const messages = [
      assistant(30),
      { id: 'msg_compact', type: 'compaction', status: 'completed', time: { created: 20 }, summary: 'summary', recent: '' },
      assistant(10, { tokens: { input: 500, output: 100, reasoning: 20, cache: { read: 200, write: 40 } } }),
    ];
    // When reading the post-compaction snapshot.
    const { total } = await readPages([page(messages)], { since: 10 });
    // Then usage before compaction remains in the cumulative total.
    expect(total).toBe(887);
  });

  test('stops before older pages once the inclusive creation cutoff is crossed', async () => {
    // Given a full second page crossing activation, with a cursor to older history.
    const pages = [page(fullPage(300), 'older'), page(fullPage(200), 'must-not-fetch')];
    // When activation is at timestamp 190.
    const { total, requests } = await readPages(pages, { since: 190 });
    // Then timestamp 190 counts, earlier creation times and older pages do not.
    expect(total).toBe(111 * 27);
    expect(requests).toHaveLength(2);
  });

  test('returns zero when history predates activation even if completion is later', async () => {
    // Given a preexisting step that completes after activation.
    const messages = [assistant(9, { time: { created: 9, completed: 20 } })];
    // When activation is at timestamp 10.
    const { total } = await readPages([page(messages)], { since: 10 });
    // Then preexisting history is excluded.
    expect(total).toBe(0);
  });

  test('accepts an empty terminal page after an exactly full page', async () => {
    // Given an exactly full history page and the server's final empty page.
    const pages = [page(fullPage(200), 'terminal'), page([])];
    // When the snapshot reaches the end of history.
    const { total } = await readPages(pages);
    // Then all completed usage is returned.
    expect(total).toBe(2700);
  });

  test.each([
    ['missing data', { cursor: {} }],
    ['legacy array', []],
    ['missing cursor envelope', { data: [] }],
    ['missing creation timestamp', page([{ id: 'msg_bad', type: 'assistant', time: {} }])],
    ['missing usage', page([assistant(10, { tokens: undefined })])],
    ['missing cache write', page([assistant(10, { tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4 } } })])],
    ['negative usage', page([assistant(10, { tokens: { input: -1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } } })])],
    ['nonnumeric usage', page([assistant(10, { tokens: { input: '1', output: 2, reasoning: 3, cache: { read: 4, write: 5 } } })])],
    ['truncated pagination', page(fullPage(200))],
    ['failed HTTP', new Response('unavailable', { status: 503 })],
    ['truncated JSON', new Response('{"data":[')],
  ])('returns null rather than partial usage for %s on a later page', async (_name, invalid) => {
    // Given a valid first page followed by an incomplete response.
    const pages = [page(fullPage(400), 'older'), invalid];
    // When the reader attempts to finish the snapshot.
    const { total } = await readPages(pages);
    // Then no partial total escapes.
    expect(total).toBeNull();
  });

  test('fails closed when a full page repeats its cursor', async () => {
    // Given two full pages that cannot advance further.
    const pages = [page(fullPage(400), 'same'), page(fullPage(300), 'same')];
    // When following the repeated cursor.
    const { total, requests } = await readPages(pages);
    // Then the reader rejects the truncated history without another request.
    expect(total).toBeNull();
    expect(requests).toHaveLength(2);
  });

  test('fails closed when cursor pages overlap', async () => {
    // Given the same completed step on two pages.
    const pages = [page(fullPage(400), 'older'), page([assistant(301)])];
    // When the reader encounters the repeated step.
    const { total } = await readPages(pages);
    // Then duplicated usage cannot inflate the budget.
    expect(total).toBeNull();
  });

  test('returns zero for a successful empty history', async () => {
    // Given a valid empty session page.
    const pages = [page([])];
    // When the snapshot is read.
    const { total } = await readPages(pages);
    // Then empty success remains distinct from failure.
    expect(total).toBe(0);
  });

  test.each([
    ['new session', [], 0],
    ['completed history', [assistant(10)], 27],
  ])('accepts nullable terminal cursors for %s', async (_name, data, expected) => {
    // Given the nullable cursor envelope returned by a real space OpenCode.
    const pages = [{ data, cursor: { previous: null, next: null } }];
    // When the complete short page is read.
    const { total } = await readPages(pages);
    // Then an empty baseline and completed usage remain authoritative successes.
    expect(total).toBe(expected);
  });
});
