import React from 'react';

import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import type { RenderedPageAsk } from '@/lib/opencode/tools';
import { answerRenderedPage } from '@/lib/renderPageAnswer';
import { DeclinePageButton } from './DeclinePageButton';
import type { HtmlRenderAnswerState, HtmlRenderSubmission } from './htmlRender';
import { PageAskStatus } from './PageAskStatus';
import { usePageDecline } from './usePageDecline';

export function useHtmlPageAnswer({ sessionId, callId, ask, readOnly = false }: {
    readonly sessionId: string;
    readonly callId: string;
    readonly ask: RenderedPageAsk;
    readonly readOnly?: boolean;
}) {
    const { t } = useI18n();
    const [sent, setSent] = React.useState<HtmlRenderSubmission | null>(null);
    const [submitting, setSubmitting] = React.useState(false);
    const [decline, sendDecline] = usePageDecline(sessionId, callId);
    const [declineInPage, setDeclineInPage] = React.useState<boolean | null>(null);
    const open = !readOnly && ask.kind === 'waiting';
    const answerState = React.useMemo<HtmlRenderAnswerState>(() => {
        if (ask.kind === 'answered') return { waiting: false, answer: ask.data };
        if (sent) return { waiting: false, answer: sent.data };
        return { waiting: open && decline === 'idle', answer: null };
    }, [ask, sent, open, decline]);
    const submit = React.useCallback(async (submission: HtmlRenderSubmission) => {
        setSubmitting(true);
        try {
            await answerRenderedPage({ sessionId, callId, ...submission });
            setSent(submission);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            toast.error(t('chat.htmlRender.answerFailed'), { description: message });
            throw error;
        } finally {
            setSubmitting(false);
        }
    }, [callId, sessionId, t]);
    const answeredSummary = ask.kind === 'answered' ? ask.summary : sent?.summary;
    const waiting = open && answeredSummary === undefined && decline !== 'declined';
    const declineButton = waiting && declineInPage === false
        ? <DeclinePageButton onDecline={sendDecline} disabled={submitting || decline === 'sending'} />
        : null;
    const status = (
        <PageAskStatus
            ask={decline === 'declined' && ask.kind === 'waiting' ? { kind: 'declined' } : ask}
            answeredSummary={answeredSummary}
        />
    );
    return { answerState, submit, sendDecline, setDeclineInPage, waiting, declineButton, status };
}
