import React from 'react';
import { checkIsGitRepository } from '@/lib/gitApi';
import { useSuggestedTasksRuntime } from '@/lib/suggestedTasksRuntime';

type GitAvailability =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly isGitRepository: boolean }
  | { readonly status: 'error'; readonly error: string };

/** Worktree actions are available only after the runtime confirms this directory is Git. */
export const useSuggestedTasksGit = (directory: string) => {
  const runtime = useSuggestedTasksRuntime();
  const [attempt, retry] = React.useReducer((value: number) => value + 1, 0);
  const [answer, setAnswer] = React.useState<{ directory: string; runtime: typeof runtime; availability: GitAvailability } | null>(null);
  React.useEffect(() => {
    let current = true;
    if (directory) {
      void (async () => {
        try {
          const isGitRepository = await checkIsGitRepository(directory);
          if (current && !runtime.signal.aborted) setAnswer({ directory, runtime, availability: { status: 'ready', isGitRepository } });
        } catch (error) {
          if (current && !runtime.signal.aborted) setAnswer({ directory, runtime, availability: { status: 'error', error: error instanceof Error ? error.message : String(error) } });
        }
      })();
    }
    return () => { current = false; };
  }, [directory, runtime, attempt]);
  const availability: GitAvailability = answer?.directory === directory && answer.runtime === runtime ? answer.availability : { status: 'loading' };
  return { availability, retry, canCreateWorktree: availability.status === 'ready' && availability.isGitRepository };
};
