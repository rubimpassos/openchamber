import path from 'node:path';
import { z } from 'zod';
import type { RunGit } from './own-commits.js';

const branchName = z.string().trim().regex(/^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,255}$/);
export const startInput = z.object({
  directory: z.string().trim().refine((value) => path.isAbsolute(value)),
  remote: branchName,
  trunk: branchName,
  branches: z.array(branchName).min(1).max(20).refine((list) => new Set(list).size === list.length),
  oldBase: z.string().regex(/^[0-9a-f]{40}$/).nullish(),
  sessionId: z.string().trim().nullish(),
});

const stepFields = {
  branch: z.string().min(1),
  onto: z.string().min(1),
  oldBase: z.string().nullable().optional(),
  before: z.string().optional(),
  after: z.string().optional(),
  worktree: z.string().optional(),
  conflictFiles: z.array(z.string()).optional(),
  error: z.string().optional(),
};
const storedStep = z.discriminatedUnion('status', [
  z.object({ ...stepFields, status: z.literal('conflict'), worktree: z.string().min(1) }).passthrough(),
  z.object({ ...stepFields, status: z.enum(['pending', 'done', 'unchanged', 'failed', 'skipped']) }).passthrough(),
]);
const runFields = z.object({
  id: z.string().min(1),
  directory: z.string().min(1),
  sessionId: z.string().nullable(),
  remote: z.string().min(1),
  trunk: z.string().min(1),
  status: z.enum(['running', 'paused', 'waitingForSession', 'done', 'failed', 'aborted']),
  conflictMode: z.enum(['pause', 'agent']),
  steps: z.array(storedStep),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export const storedRun = runFields.passthrough();
export const storedRuns = z.object({ runs: z.array(z.unknown()) });

// Runs and steps are mutated by the runtime. Their repository and run identity
// stay fixed while reservations are held, including terminal cleanup.
type ParsedRun = z.infer<typeof runFields>;
export type RestackStep = ParsedRun['steps'][number];
export type RestackRun = Omit<ParsedRun, 'id' | 'directory'> & {
  readonly id: string;
  readonly directory: string;
};
export type RestackConflictStep = Extract<RestackStep, { status: 'conflict' }>;
export type RestackStartInput = z.input<typeof startInput>;
export type RestackSessionMessage = {
  readonly sessionId: string;
  readonly directory: string;
  readonly text: string;
};
export type RestackEvent = {
  readonly type: 'openchamber:pr-stack.restack';
  readonly properties: { readonly run: RestackRun };
};
export type RestackTimer = { unref?(): unknown };
export type RestackRuntimeOptions = {
  readonly runGit: RunGit;
  readonly dataDir: string;
  readonly readConflictMode?: () => Promise<unknown>;
  readonly sendToSession?: (message: RestackSessionMessage) => Promise<unknown>;
  readonly broadcast?: (event: RestackEvent) => unknown;
  readonly now?: () => number;
  readonly setTimer?: (callback: () => Promise<void>, delay: number) => RestackTimer;
};
export interface RestackRuntime {
  start(input: unknown): Promise<RestackRun>;
  latest(directory: string): Promise<RestackRun | null>;
  continue(id: string): Promise<RestackRun>;
  abort(id: string): Promise<RestackRun>;
  askSession(id: string): Promise<RestackRun>;
  noteSessionIdle(sessionId: string | null | undefined): void;
}
