import { getRuntimeKey } from '@/lib/runtime-switch';
import { spaceIdOfDirectory } from '@/lib/spaces/space-route';

export const CONVERSATION_QUEUE_OWNER = 'bot-conversation';

type QueueIdentity = { readonly runtimeKey: string; readonly directory: string; readonly sessionId: string };
type QueueSessions = { readonly sessions: readonly { readonly sessionId: string }[] };

export const ownerSnapshotDirectory = (owner: string): string | null => (
    owner && owner !== CONVERSATION_QUEUE_OWNER ? `/spaces/${owner}` : null
);

export const snapshotOwning = <Snapshot extends QueueSessions>(
    snapshot: Snapshot & { readonly conversation?: Snapshot },
    owner: string,
    sessionId: string,
): Snapshot => {
    const { conversation } = snapshot;
    if (!conversation) return snapshot;
    const isConversationSession = owner === CONVERSATION_QUEUE_OWNER
        || conversation.sessions.some((entry) => entry.sessionId === sessionId);
    return isConversationSession ? conversation : snapshot;
};

export function createMessageQueueOwners(identityOfKey: (key: string) => QueueIdentity | null) {
    const appliedRevisions = new Map<string, number>();
    const snapshotRevisions = new Map<string, number>();
    const conversationSessions = new Set<string>();
    const scoped = (runtimeKey: string, name: string): string => `${runtimeKey}\n${name}`;

    const ownerOf = (directory: string, sessionId?: string, runtimeKey = getRuntimeKey()): string => (
        sessionId && conversationSessions.has(scoped(runtimeKey, sessionId))
            ? CONVERSATION_QUEUE_OWNER
            : spaceIdOfDirectory(directory) ?? ''
    );

    const adoptConversationSession = (runtimeKey: string, sessionId: string): void => {
        const session = scoped(runtimeKey, sessionId);
        if (conversationSessions.has(session)) return;
        conversationSessions.add(session);
        for (const key of appliedRevisions.keys()) {
            const identity = identityOfKey(key);
            if (identity?.runtimeKey === runtimeKey && identity.sessionId === sessionId) appliedRevisions.delete(key);
        }
    };

    const newestSessionRevision = (runtimeKey: string, owner: string, sessionId: string): number => {
        let newest = -1;
        for (const [key, revision] of appliedRevisions) {
            if (revision <= newest) continue;
            const identity = identityOfKey(key);
            if (identity?.runtimeKey === runtimeKey && identity.sessionId === sessionId
                && ownerOf(identity.directory, identity.sessionId, runtimeKey) === owner) {
                newest = revision;
            }
        }
        return newest;
    };

    const snapshotRevision = (runtimeKey: string, owner: string): number => (
        snapshotRevisions.get(scoped(runtimeKey, owner)) ?? -1
    );

    const recordSnapshotRevision = (runtimeKey: string, owner: string, revision: number): void => {
        snapshotRevisions.set(scoped(runtimeKey, owner), revision);
    };

    const forgetRuntime = (runtimeKey: string): void => {
        const prefix = scoped(runtimeKey, '');
        for (const key of snapshotRevisions.keys()) {
            if (key.startsWith(prefix)) snapshotRevisions.delete(key);
        }
        for (const key of appliedRevisions.keys()) {
            if (identityOfKey(key)?.runtimeKey === runtimeKey) appliedRevisions.delete(key);
        }
        for (const session of conversationSessions) {
            if (session.startsWith(prefix)) conversationSessions.delete(session);
        }
    };

    return {
        appliedRevisions, ownerOf, adoptConversationSession, newestSessionRevision,
        snapshotRevision, recordSnapshotRevision, forgetRuntime,
    };
}
