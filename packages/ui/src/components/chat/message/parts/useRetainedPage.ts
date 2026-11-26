import React from 'react';
import { useShallow } from 'zustand/react/shallow';

import { useChatTranscriptDirectory } from '@/components/chat/chatColumnSession';
import { useBotArtifactRead } from '@/hooks/useBotArtifactRead';
import type { BotArtifactFailure, BotArtifactRead } from '@/lib/bots/artifacts';
import { botAutomation } from '@/lib/bots/sessionMetadata';
import { isVSCodeRuntime } from '@/lib/desktop';
import type { Session, ToolPart } from '@/lib/opencode/model';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSession } from '@/sync/sync-context';
import { retainedPageReference } from './retainedPage';
import { useToolContentCompletion } from './useToolContentCompletion';

type RetainedPage =
    | { readonly kind: 'live' }
    | { readonly kind: 'pending' }
    | { readonly kind: 'failed'; readonly cause: BotArtifactFailure; readonly retry: (() => void) | null }
    | { readonly kind: 'ready'; readonly data: BotArtifactRead };

type SessionOwner =
    | { readonly kind: 'unknown' }
    | { readonly kind: 'ordinary' }
    | { readonly kind: 'bot'; readonly projectId: string; readonly itemId: string };

const LIVE: RetainedPage = { kind: 'live' };
const PENDING: RetainedPage = { kind: 'pending' };
const NOT_RETAINED: RetainedPage = { kind: 'failed', cause: 'failed', retry: null };
const UNKNOWN: SessionOwner = { kind: 'unknown' };
const ORDINARY: SessionOwner = { kind: 'ordinary' };

function unreachable(value: never): never {
    throw new TypeError(`Unknown retained page state: ${JSON.stringify(value)}`);
}

function classifySession(session: Session | undefined): SessionOwner {
    if (!session) return UNKNOWN;
    const found = session.metadata?.openchamber ? botAutomation(session) : null;
    return found ? { kind: 'bot', projectId: found.projectId, itemId: found.itemId } : ORDINARY;
}

function useSessionOwner(sessionId: string, directory: string | undefined): SessionOwner {
    const scoped = useSession(sessionId, directory);
    const global = useGlobalSessionsStore(useShallow((state): SessionOwner => {
        if (isVSCodeRuntime()) return ORDINARY;
        return classifySession(state.entityById.get(sessionId));
    }));
    if (isVSCodeRuntime()) return ORDINARY;
    const local = classifySession(scoped);
    switch (local.kind) {
        case 'bot': return local;
        case 'ordinary': return global.kind === 'bot' ? global : local;
        case 'unknown': return global;
        default: return unreachable(local);
    }
}

export function useRetainedPage(part: ToolPart, drawn: boolean): RetainedPage {
    const { sessionID, callID, state } = part;
    const storeDirectory = useChatTranscriptDirectory();
    const owner = useSessionOwner(sessionID, storeDirectory ?? undefined);
    const retainable = drawn && owner.kind !== 'ordinary';
    const reference = React.useMemo(() => (retainable ? retainedPageReference(state) : null), [retainable, state]);
    const scope = owner.kind === 'bot' ? owner : null;
    const needsResult = drawn && scope !== null && reference === null && state.status === 'completed';
    const completion = useToolContentCompletion(part, needsResult, storeDirectory ?? undefined);
    const read = useBotArtifactRead(scope && reference ? {
        projectId: scope.projectId, itemId: scope.itemId, artifactId: reference.id,
        call: { sessionId: sessionID, callId: callID },
    } : null);
    if (!drawn) return LIVE;
    switch (owner.kind) {
        case 'ordinary': return LIVE;
        case 'unknown': return PENDING;
        case 'bot': break;
        default: return unreachable(owner);
    }
    if (read) {
        switch (read.kind) {
            case 'loading': return PENDING;
            case 'failed': return { kind: 'failed', cause: read.cause, retry: read.retry };
            case 'ready': return { kind: 'ready', data: read.data };
            default: return unreachable(read);
        }
    }
    switch (state.status) {
        case 'pending':
        case 'running':
            return PENDING;
        case 'error':
            return NOT_RETAINED;
        case 'completed':
            switch (completion.status) {
                case 'loading': return PENDING;
                case 'failed': return { kind: 'failed', cause: 'failed', retry: completion.retry };
                case 'whole': return NOT_RETAINED;
                default: return unreachable(completion);
            }
        default:
            return unreachable(state);
    }
}
