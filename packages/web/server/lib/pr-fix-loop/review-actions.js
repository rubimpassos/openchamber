import crypto from 'node:crypto';
import { z } from 'zod';
import { markAgentText } from './agent-marker.js';
import { approvalError, receiptSchema } from './approval-contract.js';

const databaseId = z.number().int().positive();
const threadId = z.string().min(1).max(256);
const body = z.string().trim().min(1).max(4_000);
const reviewActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('thread'), id: threadId, body, resolve: z.boolean() }).strict(),
  z.object({ kind: z.literal('review'), id: databaseId, body }).strict(),
  z.object({ kind: z.literal('comment'), id: databaseId, body }).strict(),
]);
const targetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('thread'), id: threadId }).strict(),
  z.object({ kind: z.literal('review'), id: databaseId }).strict(),
  z.object({ kind: z.literal('comment'), id: databaseId }).strict(),
]);
export const reviewTurnSchema = z.object({ id: z.uuid(), targets: z.array(targetSchema).max(200) }).strict();
export const reviewJobSchema = z.object({ receipt: receiptSchema, completed: z.number().int().nonnegative(),
  dispatching: z.number().int().nonnegative().nullable(),
  // Jobs created after the agent marker existed post marked bodies.
  agentMarker: z.literal(1).optional() }).strict();
const key = (target) => `${target.kind}:${target.id}`;

// Only authenticated feedback selected for this turn can become a write target.
export const createReviewTurn = (feedback) => reviewTurnSchema.parse({ id: crypto.randomUUID(), targets: [
  ...(feedback?.threads ?? []).map(({ id }) => ({ kind: 'thread', id })),
  ...(feedback?.reviews ?? []).map(({ id }) => ({ kind: 'review', id })),
  ...(feedback?.comments ?? []).map(({ id }) => ({ kind: 'comment', id })),
] });

export const reviewInstructions = (turn) => turn.targets.length ? [
  'Return exactly one fenced `openchamber-review-actions` JSON block in your final answer.',
  `Use {"turnId":"${turn.id}","actions":[...]}. Include exactly one action per target: ${JSON.stringify(turn.targets)}.`,
  'A thread action is {"kind":"thread","id":"<assigned id>","body":"<reply>","resolve":true|false}. Resolve only fixed threads.',
  'A review or comment action is {"kind":"review"|"comment","id":<assigned numeric id>,"body":"<reply>"}.',
  'Each reply must be nonempty and at most 4000 characters. Explain any feedback you could not fix. Supply no repository, URL, method, credential or command fields.',
  'The host posts these replies and resolves fixed threads automatically after publishing the approved commit. You have no GitHub access.',
].join('\n') : '';

export function parseReviewActions(turnInput, text) {
  const turn = reviewTurnSchema.parse(turnInput);
  const blocks = [...text.matchAll(/```openchamber-review-actions\s*\n([\s\S]*?)\n```/g)];
  if (blocks.length !== 1) throw approvalError('The worker must return one bounded review-actions block for this iteration.');
  return validateReviewActions(turn, JSON.parse(blocks[0][1]));
}

export function validateReviewActions(turnInput, value) {
  const turn = reviewTurnSchema.parse(turnInput);
  const result = z.object({ turnId: z.literal(turn.id), actions: z.array(reviewActionSchema).max(200) }).strict().parse(value);
  const remaining = new Set(turn.targets.map(key));
  for (const action of result.actions) {
    if (!remaining.delete(key(action))) throw approvalError('A worker review action is duplicated or outside this iteration.');
  }
  if (remaining.size) throw approvalError('The worker omitted feedback replies from this iteration.');
  return result.actions;
}

/**
 * The host writes for one turn. `marked` adds the agent marker to every
 * posted body; a job saved before the marker existed replays without it,
 * because a replay must send the exact body its operation key was made for.
 */
export const reviewOperations = (turn, actions, { marked = false } = {}) => actions.flatMap((action, index) => {
  const idempotencyKey = `fix-review:${turn.id}:${index}`;
  const posted = (text) => (marked ? markAgentText(text) : text);
  if (action.kind === 'thread') return [
    { kind: 'thread-reply', threadId: action.id, body: posted(action.body), idempotencyKey: `${idempotencyKey}:reply` },
    ...(action.resolve ? [{ kind: 'thread-resolve', threadId: action.id, resolved: true, idempotencyKey: `${idempotencyKey}:resolve` }] : []),
  ];
  return [{ kind: 'comment', body: posted(`In response to ${action.kind} ${action.id}:\n\n${action.body}`), idempotencyKey }];
});
