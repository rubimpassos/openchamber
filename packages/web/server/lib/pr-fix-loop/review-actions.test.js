import { expect, test } from 'bun:test';
import { createReviewTurn, parseReviewActions, reviewOperations } from './review-actions.js';

const feedback = { threads: [{ id: 'PRRT_assigned' }], reviews: [{ id: 9 }], comments: [{ id: 12 }] };
const actions = () => [{ kind: 'thread', id: 'PRRT_assigned', body: 'Fixed in the approved commit.', resolve: true },
  { kind: 'review', id: 9, body: 'Addressed the requested change.' }, { kind: 'comment', id: 12, body: 'Added the regression.' }];
const block = (turn, value = actions()) => `\`\`\`openchamber-review-actions\n${JSON.stringify({ turnId: turn.id, actions: value })}\n\`\`\``;

test('builds bounded reply and resolution operations only for assigned feedback', () => {
  const turn = createReviewTurn(feedback);
  const parsed = parseReviewActions(turn, block(turn));
  const operations = reviewOperations(turn, parsed);
  expect(operations.map((entry) => entry.kind)).toEqual(['thread-reply', 'thread-resolve', 'comment', 'comment']);
  expect(new Set(operations.map((entry) => entry.idempotencyKey)).size).toBe(4);
  expect(operations[0]).toMatchObject({ threadId: 'PRRT_assigned', body: actions()[0].body });
  expect(operations.every((entry) => !('repo' in entry) && !('url' in entry) && !('method' in entry))).toBe(true);
});

test.each([
  ['unassigned thread', (value) => { value[0].id = 'PRRT_other'; }],
  ['unassigned comment', (value) => { value[2].id = 99; }],
  ['duplicate', (value) => { value.push(value[0]); }],
  ['missing reply', (value) => { value.pop(); }],
  ['generic URL', (value) => { value[0].url = 'https://github.com/other/repo'; }],
  ['oversized text', (value) => { value[0].body = 'x'.repeat(4001); }],
])('refuses %s before host mutation authority', (_label, change) => {
  const turn = createReviewTurn(feedback); const value = actions(); change(value);
  expect(() => parseReviewActions(turn, block(turn, value))).toThrow();
});

test('refuses another iteration, ambiguous blocks and a missing structured result', () => {
  const turn = createReviewTurn(feedback);
  expect(() => parseReviewActions(turn, block(createReviewTurn(feedback)))).toThrow();
  expect(() => parseReviewActions(turn, `${block(turn)}\n${block(turn)}`)).toThrow();
  expect(() => parseReviewActions(turn, 'I already resolved everything.')).toThrow();
});
