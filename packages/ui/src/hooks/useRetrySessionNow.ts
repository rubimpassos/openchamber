import React from 'react';
import { useChatSessionSelection } from '@/components/chat/chatColumnSession';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { opencodeClient } from '@/lib/opencode/client';

/**
 * Runs the automatic retry the shown session waits for right away
 * (`opencodeClient.retrySessionNow`). The caller shows it only while the
 * session waits for a retry (`working.retryInfo` from `useAssistantStatus`).
 * A second press while the first is in flight is dropped: it would interrupt
 * the attempt the first one just started.
 */
export function useRetrySessionNow(): () => void {
    const { t } = useI18n();
    const { sessionId, directory } = useChatSessionSelection();
    const inFlight = React.useRef(false);

    return React.useCallback(() => {
        if (!sessionId || inFlight.current) return;
        inFlight.current = true;
        opencodeClient.retrySessionNow(sessionId, directory)
            .catch(() => {
                toast.error(t('chat.statusRow.retryNow.failed'));
            })
            .finally(() => {
                inFlight.current = false;
            });
    }, [directory, sessionId, t]);
}
