import { afterEach, beforeEach, expect, jest, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { OpenCode } from '@opencode/client';
import { Window } from 'happy-dom';
import { installHookTestDom } from '@/components/session/sidebar/test-utils/testDom';
import { opencodeClient } from '@/lib/opencode/client';
import type { Message, Session, ToolPart } from '@/lib/opencode/model';
import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from '@/lib/runtime-url';
import { applyLaterPages, resetLaterPagesForRuntimeSwitch } from '@/sync/later-pages';
import { resetGlobalBlockingRequests, useGlobalBlockingRequestsStore } from '@/sync/global-blocking-requests';
import { SyncProvider, useDirectoryStore } from '@/sync/sync-context';
import { usePageAsk } from '@/hooks/usePageAsk';

const DIRECTORY = '/page-recovery';
const SESSION_ID = 'ses_page_recovery';
const assistant: Message = {
    id: 'msg_page', sessionID: SESSION_ID, role: 'assistant', time: { created: 1 },
    agent: 'build', providerID: 'provider', modelID: 'model',
};
const session: Session = {
    id: SESSION_ID, projectID: 'project', directory: DIRECTORY, title: 'Page',
    cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
};
const part: ToolPart = {
    id: 'call_page', callID: 'call_page', messageID: assistant.id, sessionID: SESSION_ID,
    type: 'tool', tool: 'openchamber_render',
    state: { status: 'running', input: { parameters: { awaitAnswer: true, ui: 'root = Stack([])' } }, time: { start: 1 } },
};
const sdk = OpenCode.make({ baseUrl: 'https://sync.test', fetch: () => new Promise<Response>(() => undefined) });

let dom: ReturnType<typeof installHookTestDom>;
let root: Root;
let store: ReturnType<typeof useDirectoryStore> | undefined;
let ask: ReturnType<typeof usePageAsk>;
let restoreSpies: Array<() => void>;
let previousResolver: ReturnType<typeof getRuntimeUrlResolver>;
let previousLocation: PropertyDescriptor | undefined;
let previousSurface: typeof window.__OPENCHAMBER_SURFACE__;
let recoveryRequests: string[];
let releaseRecovery: ((response: Response) => void) | undefined;
let hydrated: Promise<void>;
let registered: boolean;
let recoveryStatuses: number[];

function Probe({ state = 'waiting' }: { state?: 'waiting' | 'unanswered' }) {
    store = useDirectoryStore(DIRECTORY, { bootstrap: false });
    ask = usePageAsk(part, { kind: state });
    return null;
}

async function seed(ready = true): Promise<void> {
    const current = store;
    if (!current) throw new Error('Mount the probe before seeding its directory');
    await act(async () => current.setState({
        session: [session], message: { [SESSION_ID]: [assistant] }, part: { [assistant.id]: [part] },
        sessionStatusReady: ready, session_status: {},
    }));
}

beforeEach(async () => {
    dom = installHookTestDom(new Window().localStorage);
    previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
    Object.defineProperty(globalThis, 'location', { configurable: true, value: new URL('http://page.test/') });
    previousResolver = getRuntimeUrlResolver();
    configureRuntimeUrlResolver({ apiBaseUrl: 'http://page.test' });
    previousSurface = window.__OPENCHAMBER_SURFACE__;
    window.__OPENCHAMBER_SURFACE__ = 'desktop';
    resetLaterPagesForRuntimeSwitch();
    resetGlobalBlockingRequests();
    recoveryRequests = [];
    registered = false;
    recoveryStatuses = [];
    releaseRecovery = undefined;
    let finishHydration: () => void;
    hydrated = new Promise<void>((resolve) => { finishHydration = resolve; });
    const spies = [
        spyOn(globalThis, 'fetch').mockImplementation((input) => {
            const url = input instanceof Request ? input.url : String(input);
            if (url.endsWith('/render/recover')) {
                recoveryRequests.push(url);
                const status = recoveryStatuses.shift();
                if (status !== undefined) {
                    if (status !== 200) return Promise.resolve(Response.json({ error: 'Temporarily unavailable' }, { status }));
                    registered = true;
                    return Promise.resolve(Response.json({ page: { sessionID: SESSION_ID, callID: part.callID, status: 'open' } }));
                }
                return new Promise<Response>((resolve) => { releaseRecovery = resolve; });
            }
            if (url.endsWith('/render/later')) {
                if (registered) finishHydration();
                return Promise.resolve(Response.json({
                    revision: registered ? 101 : 100,
                    pages: registered ? [{ sessionID: SESSION_ID, callID: part.callID, status: 'open' }] : [],
                }));
            }
            return new Promise<Response>(() => undefined);
        }),
        spyOn(opencodeClient, 'getFilesystemHomeInfo').mockResolvedValue({ home: '/home' }),
        spyOn(opencodeClient, 'getFilesystemHome').mockResolvedValue('/home'),
        spyOn(opencodeClient, 'getLocation').mockResolvedValue({
            directory: DIRECTORY, project: { id: 'project', directory: DIRECTORY, canonical: DIRECTORY },
        }),
        spyOn(opencodeClient, 'getConfig').mockResolvedValue({}),
        spyOn(opencodeClient, 'listProjects').mockResolvedValue([]),
        spyOn(opencodeClient, 'listSessionsPage').mockImplementation(() => new Promise<never>(() => undefined)),
        spyOn(opencodeClient, 'getActiveSessionStatuses').mockImplementation(() => new Promise<never>(() => undefined)),
        spyOn(opencodeClient, 'listPendingForms').mockImplementation(() => new Promise<never>(() => undefined)),
        spyOn(opencodeClient, 'listPendingPermissions').mockImplementation(() => new Promise<never>(() => undefined)),
        spyOn(opencodeClient, 'listRunningShells').mockImplementation(() => new Promise<never>(() => undefined)),
        spyOn(opencodeClient, 'getVcs').mockImplementation(() => new Promise<never>(() => undefined)),
    ];
    restoreSpies = spies.map((spy) => () => spy.mockRestore());
    store = undefined;
    ask = undefined;
    root = createRoot(dom.container);
    await act(async () => root.render(<SyncProvider sdk={sdk} directory={DIRECTORY}><Probe /></SyncProvider>));
});

afterEach(async () => {
    await act(async () => root.unmount());
    restoreSpies.forEach((restore) => restore());
    resetLaterPagesForRuntimeSwitch();
    resetGlobalBlockingRequests();
    setRuntimeUrlResolver(previousResolver);
    window.__OPENCHAMBER_SURFACE__ = previousSurface;
    if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation);
    else Reflect.deleteProperty(globalThis, 'location');
    dom.restore();
});

test('restores controls from server recovery only after the idle snapshot arrives', async () => {
    await seed(false);
    expect(recoveryRequests).toEqual([]);
    await seed();
    expect(recoveryRequests).toHaveLength(1);
    expect(ask).toEqual({ kind: 'unanswered' });
    const release = releaseRecovery;
    if (!release) throw new Error('An idle stranded page must request recovery');
    await act(async () => {
        registered = true;
        release(Response.json({ page: { sessionID: SESSION_ID, callID: part.callID, status: 'open' } }));
        await hydrated;
    });
    expect(ask).toEqual({ kind: 'waiting', later: true });
});

test('shows an answer made on another client for an interrupted source call', async () => {
    await act(async () => root.render(<SyncProvider sdk={sdk} directory={DIRECTORY}><Probe state="unanswered" /></SyncProvider>));
    await act(async () => applyLaterPages(100, SESSION_ID, [{
        sessionID: SESSION_ID, callID: part.callID, status: 'answered', summary: 'Red', data: { color: 'red' },
    }]));
    expect(ask).toEqual({ kind: 'answered', summary: 'Red', data: { color: 'red' } });
});

test('does not recover a historical page when a newer conversation message exists', async () => {
    await seed(false);
    const current = store;
    if (!current) throw new Error('Expected the mounted directory');
    await act(async () => current.setState({
        sessionStatusReady: true,
        message: { [SESSION_ID]: [assistant, { id: 'msg_new', sessionID: SESSION_ID, role: 'user', time: { created: 2 } }] },
    }));
    expect(recoveryRequests).toEqual([]);
    expect(ask).toEqual({ kind: 'unanswered' });
});

test('keeps a server-confirmed live waiter above an earlier closed recovery', async () => {
    await act(async () => {
        applyLaterPages(100, SESSION_ID, [{
            sessionID: SESSION_ID, callID: part.callID, source: 'recovered-await', status: 'closed',
        }]);
        useGlobalBlockingRequestsStore.setState({ bySession: new Map([[SESSION_ID, {
            directory: DIRECTORY, permissions: [], forms: [], pages: [{ id: part.callID, sessionID: SESSION_ID, title: 'Live page' }],
        }]]) });
    });
    expect(ask).toEqual({ kind: 'waiting' });
    expect(recoveryRequests).toEqual([]);
});

test('recovers from a temporary read failure without reconnecting or reopening the conversation', async () => {
    jest.useFakeTimers();
    try {
        recoveryStatuses = [503, 200];
        await seed();
        await act(async () => {
            jest.advanceTimersByTime(500);
            await hydrated;
        });
        expect(recoveryRequests).toHaveLength(2);
        expect(ask).toEqual({ kind: 'waiting', later: true });
    } finally {
        jest.useRealTimers();
    }
});
