import { useEffect } from 'react';
import type { RenderedPageAsk } from '@/lib/opencode/tools';
import type { ToolPart } from '@/lib/opencode/model';
import { isVSCodeRuntime } from '@/lib/desktop';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { findLastContentMessageIndex } from '@/lib/questions/orphanedQuestions';
import { useIsCallWaiting } from '@/sync/global-blocking-requests';
import { useLaterPage, type LaterPage } from '@/sync/later-pages';
import { recoverRenderedPage } from '@/sync/recover-rendered-page';
import { useSessionDirectory, useSessionMessagesSelector, useSessionStatus, useSessionStatusSnapshotReady } from '@/sync/sync-context';

const lastContentMessageId = (messages: Parameters<typeof findLastContentMessageIndex>[0]) => (
    messages[findLastContentMessageIndex(messages)]?.id
);

export const livePageAsk = (ask: RenderedPageAsk, announced: boolean, sessionIdle: boolean): RenderedPageAsk => (
    ask.kind === 'waiting' && !announced && sessionIdle ? { kind: 'unanswered' } : ask
);

export const laterPageAsk = (page: LaterPage | undefined): RenderedPageAsk => {
    if (page?.status === 'open') return { kind: 'waiting', later: true };
    if (page?.status === 'closed') return { kind: 'unanswered' };
    const undelivered = page?.undelivered ? { undelivered: true as const } : {};
    if (page?.status === 'answered') return { kind: 'answered', summary: page.summary ?? '', data: page.data ?? null, ...undelivered };
    if (page?.status === 'declined') return { kind: 'declined', ...undelivered };
    if (page?.status === 'ui-not-drawn') return { kind: 'not-drawn', ...undelivered };
    return { kind: 'show' };
};

export const pageBlocksTurn = (ask: RenderedPageAsk): boolean => ask.kind === 'waiting' && ask.later !== true;

export function usePageAsk(part: ToolPart, ask: RenderedPageAsk | undefined): RenderedPageAsk | undefined {
    const unresolved = ask?.kind === 'waiting' || ask?.kind === 'unanswered';
    const laterPage = useLaterPage(unresolved || ask?.kind === 'later' ? part.sessionID : '', part.callID);
    const sessionId = unresolved ? part.sessionID : '';
    const directory = useSessionDirectory(sessionId);
    const announced = useIsCallWaiting(sessionId, part.callID);
    const status = useSessionStatus(sessionId, directory);
    const snapshotReady = useSessionStatusSnapshotReady(directory, sessionId);
    const latestMessageId = useSessionMessagesSelector(sessionId, directory, lastContentMessageId);
    const canRecover = unresolved && !laterPage && !announced && snapshotReady
        && (!status || status.type === 'idle') && latestMessageId === part.messageID;
    const { messageID, callID } = part;
    useEffect(() => {
        if (!canRecover || isVSCodeRuntime()) return;
        const controller = new AbortController();
        const recover = () => {
            void recoverRenderedPage({ sessionId, messageId: messageID, callId: callID }, controller.signal)
                .catch((error: unknown) => {
                    if (!controller.signal.aborted) console.warn('[render.page] Could not recover the question:', error);
                });
        };
        recover();
        const unsubscribe = subscribeOpenchamberEvents((event) => {
            if (event.type === 'event-stream-ready') recover();
        });
        return () => {
            controller.abort();
            unsubscribe();
        };
    }, [canRecover, sessionId, messageID, callID]);
    if (!ask) return undefined;
    if (announced && ask.kind === 'waiting') return ask;
    if (laterPage || ask.kind === 'later') return laterPageAsk(laterPage);
    return livePageAsk(ask, announced, status ? status.type === 'idle' : snapshotReady);
}
