import { requireLocalRuntime } from '../server-frame/local-runtime.js';
import { isGitHubRateLimited, noteIfGitHubRateLimit, noteGitHubRateLimit } from '../github/rate-limit.js';
import { isGraphqlRateLimitError } from '../github/pr-summaries.js';
import { errorField } from './errors.js';
import type { RuntimeOptions } from './contracts.js';
import type { GitHubFeedbackReader } from '../github/pr-feedback-reader.js';
import type { createAgentFixLoopServices } from '../agent-server/fix-loop-services.js';
import type { createAgentBotServices } from '../agent-server/bot-services.js';
import type { createBotsHost } from '../bots/host.js';
import type { createSessionActivityProbe } from '../opencode/session-activity.js';
import type { createMessageQueueRuntime, PublicQueuedItem } from '../message-queue/runtime.js';

type AgentFixLoops = ReturnType<typeof createAgentFixLoopServices>;
type AgentBots = ReturnType<typeof createAgentBotServices>;
export type FixLoopClient = GitHubFeedbackReader
  | NonNullable<Awaited<ReturnType<AgentFixLoops['getOctokit']>>>
  | Awaited<ReturnType<AgentBots['pullRequests']['getOctokit']>>;
type HostAdapters = Pick<RuntimeOptions<FixLoopClient>, 'botWatch' | 'getOctokit' | 'readFeedback'
  | 'readAuthorPermission' | 'readFailedChecks' | 'isRateLimited' | 'noteRateLimit'
  | 'isSessionWorking' | 'hasQueuedItem' | 'enqueue' | 'readTokenSnapshot'>;
type HostAdapterOptions = {
  readonly frontDoor: boolean;
  readonly getBotHost: () => ReturnType<typeof createBotsHost> | null;
  readonly getAgentFixLoops: () => AgentFixLoops;
  readonly getAgentBots: () => AgentBots;
  readonly localOctokit: (accountId?: string | null) => Promise<GitHubFeedbackReader | null>;
  readonly getActivity: () => ReturnType<typeof createSessionActivityProbe>;
  readonly getQueue: () => ReturnType<typeof createMessageQueueRuntime> | null;
  readonly readHostTokens: NonNullable<HostAdapters['readTokenSnapshot']>;
};

export function createFixLoopHostAdapters({ frontDoor, getBotHost, getAgentFixLoops, getAgentBots,
  localOctokit, getActivity, getQueue, readHostTokens }: HostAdapterOptions): HostAdapters {
  return {
    botWatch: {
      getOctokit: (...args) => requireLocalRuntime(getBotHost(), 'Bot host').botWatch.getOctokit(...args),
      deliver: (...args) => requireLocalRuntime(getBotHost(), 'Bot host').botWatch.deliver(...args),
      authorizeApp: (authority, author) => requireLocalRuntime(getBotHost(), 'Bot host').botWatch.authorizeApp(authority, author),
    },
    getOctokit: frontDoor ? getAgentFixLoops().getOctokit : localOctokit,
    readFeedback: async ({ octokit, ...input }) => {
      if ('botAuthority' in octokit) return getAgentBots().readFeedback({ ...input, octokit });
      if ('accountId' in octokit) return getAgentFixLoops().readFeedback({ ...input, octokit });
      return (await import('../github/pr-feedback.js')).readPullFeedback({ ...input, octokit });
    },
    readAuthorPermission: async ({ octokit, ...input }) => {
      if ('botAuthority' in octokit) return getAgentBots().readAuthorPermission({ ...input, octokit });
      if ('accountId' in octokit) return getAgentFixLoops().readAuthorPermission({ ...input, octokit });
      return (await import('../github/pr-feedback.js')).readFeedbackAuthorPermission({ ...input, octokit });
    },
    readFailedChecks: async ({ octokit, ...input }) => {
      if ('botAuthority' in octokit) return getAgentBots().readFailedChecks({ ...input, octokit });
      if ('accountId' in octokit) return getAgentFixLoops().readFailedChecks({ ...input, octokit });
      return (await import('../github/pr-feedback.js')).readFailedChecks({ ...input, octokit });
    },
    isRateLimited: () => !frontDoor && isGitHubRateLimited(),
    noteRateLimit: (error) => {
      if (frontDoor) return errorField(error, 'statusCode') === 429;
      if (isGraphqlRateLimitError(error)) {
        noteGitHubRateLimit(error);
        return true;
      }
      return noteIfGitHubRateLimit(error);
    },
    isSessionWorking: async (sessionId) => {
      const isolated = await getBotHost()?.isSessionWorking(sessionId);
      if (isolated !== undefined) return isolated;
      const activity = getActivity();
      const statuses = await activity.fetchActiveSessionStatuses();
      if (!statuses) return null;
      if (statuses[sessionId]) return true;
      return activity.hasWorkingChildren(sessionId, statuses);
    },
    hasQueuedItem: async (sessionId, loopId) => {
      const host = getBotHost();
      const queue = requireLocalRuntime(host ? await host.queueForSession(sessionId) : getQueue(), 'Message queue');
      await queue.load();
      return (queue.sessionSnapshot(sessionId)?.items ?? [])
        .some((item: Pick<PublicQueuedItem, 'origin'>) => item.origin?.kind === 'pr-fix-loop' && item.origin.id === loopId);
    },
    enqueue: async (sessionId, directory, item) => {
      const host = getBotHost();
      const queue = requireLocalRuntime(host ? await host.queueForSession(sessionId) : getQueue(), 'Message queue');
      await queue.enqueue(sessionId, directory, item);
    },
    readTokenSnapshot: (...args) => {
      const host = getBotHost();
      return host ? host.readTokenSnapshot(...args) : readHostTokens(...args);
    },
  };
}
