import { useMemo, useReducer } from 'react';
import type { FormRequest, Part } from '@/lib/opencode/model';
import { projectQuestionForm } from '@/lib/opencode/projection';
import { useSessionMessages, useSessionPartsForMessages, useSessionStatus, useSessionSelector, useSessionStatusSnapshotReady } from '@/sync/sync-context';
import { collectOrphanedQuestionRequests, findLastContentMessageIndex, wasInterruptedByInactivity } from './orphanedQuestions';

const NO_PARTS: Part[] = [];

export function useOrphanedQuestions(sessionId: string | null, directory: string | undefined, forms: FormRequest[]) {
  const messages = useSessionMessages(sessionId ?? '', directory);
  const lastMessage = messages[findLastContentMessageIndex(messages)];
  const lastMessageId = lastMessage?.id;
  const lastMessageIds = useMemo(() => (lastMessageId ? [lastMessageId] : []), [lastMessageId]);
  const parts = useSessionPartsForMessages(lastMessageIds, directory)[lastMessageId ?? ''] ?? NO_PARTS;
  const status = useSessionStatus(sessionId ?? '', directory);
  const statusReady = useSessionStatusSnapshotReady(directory, sessionId ?? undefined);
  const interruptedByInactivity = useSessionSelector(sessionId, directory, wasInterruptedByInactivity);
  const [, refresh] = useReducer((value: number) => value + 1, 0);
  // Dismissals live in localStorage; refresh must read them even when sync inputs are unchanged.
  const questions = (() => {
    if (!sessionId || !lastMessage || !statusReady || (status && status.type !== 'idle')) return [];
    const live = forms.map(projectQuestionForm).filter((form) => form !== null);
    return collectOrphanedQuestionRequests(sessionId, [{ info: lastMessage, parts }], live, interruptedByInactivity);
  })();
  return { questions, refresh };
}
