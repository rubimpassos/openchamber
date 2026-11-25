import React from 'react';

import { fetchBotArtifact, type BotArtifactRead } from '@/lib/bots/artifacts';
import { useBotsRuntime } from '@/lib/botsRuntime';

type BotArtifactCall = { readonly sessionId: string; readonly callId: string };
type BotArtifactTarget = {
    readonly projectId: string;
    readonly itemId: string;
    readonly artifactId: string;
    readonly call?: BotArtifactCall;
};
type BotArtifactReadState =
    | { readonly kind: 'loading' }
    | { readonly kind: 'failed'; readonly retry: () => void }
    | { readonly kind: 'ready'; readonly data: BotArtifactRead };

type Snapshot = Pick<BotArtifactRead, 'artifact' | 'payload'>;
type Held = { readonly request: string; readonly data: BotArtifactRead | null };

const MAX_REMEMBERED_CHARACTERS = 64 * 1024 * 1024;
const remembered = new Map<string, { readonly snapshot: Snapshot; readonly characters: number }>();
let rememberedCharacters = 0;
let rememberedGeneration = -1;

function remember(generation: number, key: string, { artifact, payload }: BotArtifactRead): void {
    if (generation !== rememberedGeneration) {
        remembered.clear();
        rememberedCharacters = 0;
        rememberedGeneration = generation;
    }
    const characters = payload.assets.reduce(
        (total, asset) => total + (asset.status === 'ready' ? asset.data.length : 0),
        payload.body.content.length,
    );
    rememberedCharacters += characters - (remembered.get(key)?.characters ?? 0);
    remembered.delete(key);
    remembered.set(key, { snapshot: { artifact, payload }, characters });
    for (const [oldest, entry] of remembered) {
        if (rememberedCharacters <= MAX_REMEMBERED_CHARACTERS || oldest === key) break;
        remembered.delete(oldest);
        rememberedCharacters -= entry.characters;
    }
}

const isSnapshotOf = ({ artifact }: Snapshot, artifactId: string, call: BotArtifactCall | null): boolean => (
    artifact.id === artifactId
    && (call === null || (artifact.source.sessionId === call.sessionId && artifact.source.callId === call.callId))
);

export function useBotArtifactRead(target: BotArtifactTarget, fresh?: boolean): BotArtifactReadState;
export function useBotArtifactRead(target: BotArtifactTarget | null, fresh?: boolean): BotArtifactReadState | null;
export function useBotArtifactRead(target: BotArtifactTarget | null, fresh = false): BotArtifactReadState | null {
    const runtime = useBotsRuntime();
    const [attempt, retry] = React.useReducer((count: number) => count + 1, 0);
    const [held, setHeld] = React.useState<Held | null>(null);
    const projectId = target?.projectId;
    const itemId = target?.itemId;
    const artifactId = target?.artifactId;
    const sessionId = target?.call?.sessionId;
    const callId = target?.call?.callId;
    const call = React.useMemo<BotArtifactCall | null>(
        () => (sessionId && callId ? { sessionId, callId } : null),
        [sessionId, callId],
    );
    const key = target ? JSON.stringify([runtime.generation, projectId, itemId, artifactId]) : null;
    const request = key === null ? null : JSON.stringify([key, sessionId, callId, attempt]);
    let current = held !== null && held.request === request ? held : null;
    if (request !== null && key !== null && artifactId && current === null && !fresh) {
        const snapshot = remembered.get(key)?.snapshot;
        if (snapshot && isSnapshotOf(snapshot, artifactId, call)) {
            current = { request, data: snapshot };
            setHeld(current);
        }
    }
    const pending = request !== null && current === null;
    React.useEffect(() => {
        if (!pending || request === null || key === null || !projectId || !itemId || !artifactId) return;
        const controller = new AbortController();
        const settle = (read: BotArtifactRead | null) => {
            if (controller.signal.aborted || runtime.signal.aborted) return;
            const data = read && isSnapshotOf(read, artifactId, call) ? read : null;
            if (data) remember(runtime.generation, key, data);
            setHeld({ request, data });
        };
        void fetchBotArtifact({ projectId, itemId }, artifactId, controller.signal).then(settle, () => settle(null));
        return () => controller.abort();
    }, [pending, request, key, projectId, itemId, artifactId, call, runtime]);
    if (request === null) return null;
    if (current === null) return { kind: 'loading' };
    return current.data ? { kind: 'ready', data: current.data } : { kind: 'failed', retry };
}
