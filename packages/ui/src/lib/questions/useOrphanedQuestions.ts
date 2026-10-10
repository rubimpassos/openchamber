import { useMemo, useReducer } from 'react';
import type { FormRequest, Part } from '@/lib/opencode/model';
import { projectQuestionForm } from '@/lib/opencode/projection';
import { useSessionMessages, useSessionPartsForMessages, useSessionStatus, useSessionStatusSnapshotReady } from '@/sync/sync-context';
import { collectOrphanedQuestionRequests } from './orphanedQuestions';

const NO_PARTS: Part[] = [];

export function useOrphanedQuestions(sessionId: string | null, directory: string | undefined, forms: FormRequest[]) {
  const messages = useSessionMessages(sessionId ?? '', directory);
  let lastIndex = messages.length - 1;
  while (lastIndex >= 0 && messages[lastIndex].role === 'idle') lastIndex -= 1;
  const lastMessage = messages[lastIndex];
  const lastMessageId = lastMessage?.id;
  const lastMessageIds = useMemo(() => (lastMessageId ? [lastMessageId] : []), [lastMessageId]);
  const parts = useSessionPartsForMessages(lastMessageIds, directory)[lastMessageId ?? ''] ?? NO_PARTS;
  const status = useSessionStatus(sessionId ?? '', directory);
  const statusReady = useSessionStatusSnapshotReady(directory, sessionId ?? undefined);
  const [revision, refresh] = useReducer((value: number) => value + 1, 0);
  const questions = useMemo(() => {
    if (!sessionId || !lastMessage || !statusReady || (status && status.type !== 'idle')) return [];
    const live = forms.map(projectQuestionForm).filter((form) => form !== null);
    return collectOrphanedQuestionRequests(sessionId, [{ info: lastMessage, parts }], live);
  }, [sessionId, lastMessage, parts, status, statusReady, forms, revision]);
  return { questions, refresh };
}
