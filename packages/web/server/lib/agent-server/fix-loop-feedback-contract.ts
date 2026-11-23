import { z } from 'zod';
import { commitSchema } from '../pr-fix-loop/approval-contract.js';
import { AGENT_SIGNATURE, isAgentText } from '../pr-fix-loop/agent-marker.js';

/**
 * What the runtime reads of a feedback body: the agent marker, the loop's mention, whether it is
 * empty, and its first 4,000 characters for the worker's prompt (`MAX_TEXT` in runtime.js). The
 * agent clips longer bodies and adds the marker and the mention back when the cut removed them, so
 * every check gives the answer the full body gives. A clip that cannot fit the reply cap is retried
 * shorter; prompts then quote less of the longest comments, and the checks still hold.
 */
const BODY_LIMITS = [4_000, 1_000, 100] as const;
const BODY_SLACK = 512;
const text = z.string().max(BODY_LIMITS[0] + BODY_SLACK);
const short = z.string().max(4096);
const id = z.number().int().positive();
const author = z.object({ login: z.string().min(1).max(256), bot: z.boolean() });
const comment = z.object({ id: id.nullable(), body: text, url: short, createdAt: short.nullable(), author });
export const checkContextsSchema = z.array(z.discriminatedUnion('__typename', [
  z.object({ __typename: z.literal('CheckRun'), databaseId: id.nullable(), name: short, status: short,
    conclusion: short.nullable(), startedAt: short.nullable(), detailsUrl: short.nullable(),
    checkSuite: z.object({ app: z.object({ databaseId: id.nullable(), slug: short }).nullable() }).nullable() }),
  z.object({ __typename: z.literal('StatusContext'), context: short, state: short, targetUrl: short.nullable(), description: short.nullable() }),
])).max(100);
const headRepoSchema = z.object({ id: z.string().min(1).max(256),
  owner: z.string().regex(/^[A-Za-z0-9_.-]{1,256}$/), repo: z.string().regex(/^[A-Za-z0-9_.-]{1,256}$/) });
export const headSnapshotSchema = z.object({ state: z.enum(['open', 'closed', 'merged']), branch: short.min(1).max(1024),
  headSha: commitSchema, headRepo: headRepoSchema.nullable() });
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const feedbackReplySchema = headSnapshotSchema.extend({
  viewer: z.string().min(1).max(256), title: short, url: short, base: short, reviewDecision: short.nullable(),
  ci: z.object({ state: z.enum(['success', 'failure', 'pending', 'unknown']), total: count.max(100),
    success: count.max(100), failure: count.max(100), pending: count.max(100), contexts: checkContextsSchema }),
  reviews: z.array(comment.extend({ state: short })).max(50),
  threads: z.array(z.object({ id: z.string().min(1).max(256), resolved: z.boolean(), outdated: z.boolean(),
    path: short, line: id.nullable(), comments: z.array(comment).max(30) })).max(100),
  comments: z.array(comment).max(50),
});
export const failedChecksReplySchema = z.array(z.object({ name: short, url: short.nullable(), summary: text.nullable(),
  steps: z.array(z.object({ name: short, conclusion: short })).max(256),
  annotations: z.array(z.object({ path: short.nullable(), line: id.nullable(), level: short.nullable(), message: z.string().max(500) })).max(20),
  log: z.string().max(6000).nullable(), missing: z.array(z.enum(['annotations', 'steps', 'log'])).max(3).optional(),
})).max(5);

const clipBody = (body: unknown, limit: number, mentionText: string | undefined) => {
  const value = String(body ?? '');
  if (value.length <= limit) return value;
  // Every check the runtime makes on a body gives the trimmed text's answer: whitespace alone counts for nothing.
  const trimmed = value.trim();
  if (trimmed.length <= limit) return trimmed;
  let clipped = `${trimmed.slice(0, limit)}…`;
  const mention = mentionText?.toLowerCase();
  if (mention && trimmed.toLowerCase().includes(mention) && !clipped.toLowerCase().includes(mention)) clipped += `\n${mentionText}`;
  if (isAgentText(trimmed) && !isAgentText(clipped)) clipped += `\n${AGENT_SIGNATURE}`;
  return clipped;
};

type FeedbackBodies = {
  readonly reviews: readonly { readonly body?: unknown }[];
  readonly comments: readonly { readonly body?: unknown }[];
  readonly threads: readonly { readonly comments: readonly { readonly body?: unknown }[] }[];
};
type FeedbackFitOptions = { readonly mentionText?: string | undefined; readonly cap: number };
type ClippedBody<Entry> = Omit<Entry, 'body'> & { readonly body: string };
type FittedFeedback<Snapshot extends FeedbackBodies> = Omit<Snapshot, 'reviews' | 'comments' | 'threads'> & {
  readonly reviews: ClippedBody<Snapshot['reviews'][number]>[];
  readonly comments: ClippedBody<Snapshot['comments'][number]>[];
  readonly threads: (Omit<Snapshot['threads'][number], 'comments'> & {
    readonly comments: ClippedBody<Snapshot['threads'][number]['comments'][number]>[];
  })[];
};

export type FeedbackReply = z.infer<typeof feedbackReplySchema>;
export type FailedChecksReply = z.infer<typeof failedChecksReplySchema>;
export type CheckContexts = z.infer<typeof checkContextsSchema>;

/** The feedback reply the agent sends: bodies clipped to the first limit whose JSON fits `cap` bytes. */
export function fitFeedback<Snapshot extends FeedbackBodies>(snapshot: Snapshot, { mentionText, cap }: FeedbackFitOptions): FittedFeedback<Snapshot> | null {
  for (const limit of BODY_LIMITS) {
    const clip = <Entry extends { readonly body?: unknown }>(entry: Entry): ClippedBody<Entry> => ({ ...entry, body: clipBody(entry.body, limit, mentionText) });
    const fitted: FittedFeedback<Snapshot> = { ...snapshot,
      reviews: snapshot.reviews.map((entry: Snapshot['reviews'][number]) => clip(entry)),
      comments: snapshot.comments.map((entry: Snapshot['comments'][number]) => clip(entry)),
      threads: snapshot.threads.map((thread: Snapshot['threads'][number]) => ({ ...thread,
        comments: thread.comments.map((entry: Snapshot['threads'][number]['comments'][number]) => clip(entry)) })) };
    if (Buffer.byteLength(JSON.stringify(fitted)) <= cap) return fitted;
  }
  return null;
}
