import { afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import { SyncProvider } from '@/sync/sync-context';
import type { MessageListHandle } from './MessageList';
import { ChatColumnSessionContext } from './chatColumnSession';
import { I18nProvider } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { useGuestsStore } from '@/lib/guests/store';
import type { InstalledGuest } from '@/lib/guests/types';
import type { ChatMessageEntry } from './lib/turns/types';
import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import type { RuntimeAPIs } from '@/lib/api/types';

const { default: MessageList } = await import('./MessageList');

const SESSION = 'guest-activity';
const extension: InstalledGuest = {
    id: 'tasks', name: 'Tasks', icon: 'robot-2', enabled: true, capabilities: { requested: [], granted: [] },
    messages: [{
        match: '^\\[TASK (?<status>DONE|FAILED)\\][\\s\\S]*?\\*\\*Description:\\*\\* (?<description>.+)',
        name: 'Background task', title: 'Background task {match.status}', subtitle: '{match.description}', tone: 'success',
    }],
};
const NOTICE = '<system-reminder>\n[TASK DONE]\n**Description:** Find the auth middleware\n</system-reminder>\n<!-- SENT BY TASKS -->';

const user = (id: string, text: string, created: number): ChatMessageEntry => ({
    info: { id, sessionID: SESSION, role: 'user', time: { created } },
    parts: [{ id: `${id}-text`, sessionID: SESSION, messageID: id, type: 'text', text }],
});
const assistant = (id: string, created: number, finish: 'tool-calls' | 'stop', text: string): ChatMessageEntry => ({
    info: { id, sessionID: SESSION, role: 'assistant', agent: 'build', providerID: 'mock', modelID: 'mock', finish, time: { created, completed: created + 1 } },
    parts: [
        { id: `${id}-text`, sessionID: SESSION, messageID: id, type: 'text', text, time: { start: created, end: created + 1 } },
        ...(finish === 'tool-calls' ? [{
            id: `${id}-read`, sessionID: SESSION, messageID: id, type: 'tool' as const, tool: 'read', callID: `${id}-read`,
            state: { status: 'completed' as const, input: { filePath: '/repo/auth.ts' }, output: 'code', metadata: {}, time: { start: created, end: created + 1 } },
        }] : []),
    ],
});

const prompt = [user('prompt', 'Find the middleware.', 1), assistant('prompt-answer', 2, 'stop', 'Launched a task.')];
const noticeTurn = [user('notice', NOTICE, 10), assistant('notice-step', 11, 'tool-calls', 'Reading the result first.'), assistant('notice-answer', 13, 'stop', 'It lives in auth.ts.')];

let host: HTMLElement;
let root: Root;
let restore: () => Promise<void>;
let flush: () => Promise<void>;
const ref = React.createRef<MessageListHandle>();

beforeEach(() => {
    const dom = new Window({ url: 'https://app.test' });
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    const requestAnimationFrame = (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; };
    const cancelAnimationFrame = (id: number) => { frames.delete(id); };
    Object.assign(dom, { requestAnimationFrame, cancelAnimationFrame });
    Object.defineProperties(dom.HTMLElement.prototype, {
        clientHeight: { configurable: true, get: () => 2400 },
        clientWidth: { configurable: true, get: () => 800 },
    });
    // A tall scroller over short rows, so the list mounts every row of these short transcripts.
    dom.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
        return new dom.DOMRect(0, 0, 800, this.style.overflowY === 'auto' ? 2400 : 40);
    };
    const values = {
        window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement, Element: dom.Element,
        Event: dom.Event, CustomEvent: dom.CustomEvent,
        Node: dom.Node, localStorage: dom.localStorage, sessionStorage: dom.sessionStorage,
        getComputedStyle: dom.getComputedStyle.bind(dom), ResizeObserver: dom.ResizeObserver, MutationObserver: dom.MutationObserver,
        requestAnimationFrame, cancelAnimationFrame, CSS: { escape: (value: string) => value }, IS_REACT_ACT_ENVIRONMENT: true,
    };
    const previous = Object.keys(values).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
    for (const [name, value] of Object.entries(values)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => new Promise(() => {});
    const ui = useUIStore.getState();
    const previousUi = { activityRenderMode: ui.activityRenderMode, showReasoningTraces: ui.showReasoningTraces, stickyUserHeader: ui.stickyUserHeader };
    const previousGuests = useGuestsStore.getState().guests;
    useUIStore.setState({ activityRenderMode: 'collapsed', showReasoningTraces: true, stickyUserHeader: false });
    useGuestsStore.setState({ guests: [extension] });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    flush = async () => {
        for (let round = 0; round < 5; round += 1) {
            await act(async () => {
                await new Promise<void>((resolve) => dom.setTimeout(resolve, 0));
                const pending = [...frames.values()];
                frames.clear();
                pending.forEach((callback) => callback(0));
            });
        }
    };
    restore = async () => {
        await act(async () => root.unmount());
        useUIStore.setState(previousUi);
        useGuestsStore.setState({ guests: previousGuests });
        globalThis.fetch = originalFetch;
        for (const [name, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else Reflect.deleteProperty(globalThis, name);
        }
        await dom.happyDOM.close();
    };
});

afterEach(() => restore());

const unavailable = (): never => { throw new Error('The transcript must not call runtime APIs'); };
const runtime: RuntimeAPIs = {
    runtime: { platform: 'web', isDesktop: false, isVSCode: false },
    get terminal() { return unavailable(); }, get git() { return unavailable(); },
    get files() { return unavailable(); }, get settings() { return unavailable(); },
    get permissions() { return unavailable(); }, get notifications() { return unavailable(); },
    get sourceControl() { return unavailable(); },
};
const sdk = OpenCode.make({ baseUrl: 'https://timeline.test', fetch: () => new Promise<Response>(() => {}) });

const show = async (messages: ChatMessageEntry[]) => {
    await act(async () => {
        root.render(
            <RuntimeAPIContext.Provider value={runtime}>
                <ThemeSystemProvider>
                    <SyncProvider sdk={sdk} directory="/repo">
                        <I18nProvider>
                            <ChatColumnSessionContext.Provider value={{ sessionId: SESSION, directory: '/repo' }}>
                                <MessageList ref={ref} sessionKey={SESSION} messages={messages} isLoadingOlder={false} />
                            </ChatColumnSessionContext.Provider>
                        </I18nProvider>
                    </SyncProvider>
                </ThemeSystemProvider>
            </RuntimeAPIContext.Provider>,
        );
    });
    await flush();
};

// What a reader can see: rows inside a closed fold are inert.
const visible = (selector: string) => [...host.querySelectorAll<HTMLElement>(selector)].filter((element) => !element.closest('[inert]'));
const notices = () => visible('[data-guest-message]');
const bubbles = () => visible('[data-user-message-bubble]').map((bubble) => bubble.textContent ?? '');
const fold = () => host.querySelector<HTMLElement>('[data-live-turn-activity="notice"]');
const head = () => host.querySelector<HTMLElement>('#turn-notice');
const toggleFold = () => act(async () => fold()?.querySelector<HTMLButtonElement>('button[aria-controls]')?.click());
// Where the list places the row an element is drawn in; rows are positioned, so DOM order says nothing.
const rowTop = (element: Element | null | undefined): number => (
    Number.parseFloat(element?.closest<HTMLElement>('[data-row-key]')?.parentElement?.style.top ?? '')
);

test('a plugin message an extension claims is a step of its turn\'s Activity, drawn once and only there', async () => {
    await show([...prompt, ...noticeTurn]);
    // Closed: the notice is nowhere, its turn is still a turn, and the prompt keeps its bubble.
    expect(notices()).toHaveLength(0);
    expect(host.textContent).not.toContain('Background task DONE');
    expect(bubbles()).toEqual(['Find the middleware.']);
    expect(head()).not.toBeNull();
    expect(fold()).not.toBeNull();
    expect(host.textContent).toContain('It lives in auth.ts.');

    await toggleFold();
    await flush();
    expect(notices()).toHaveLength(1);
    const notice = notices()[0];
    expect(notice?.id).toBe('message-notice');
    expect(notice?.textContent).toContain('Background task DONE');
    expect(notice?.textContent).toContain('Find the auth middleware');
    expect(head()?.contains(notice ?? null)).toBe(false);
    // In the order it was sent: under the fold's header, above the step that answered it.
    expect(notice?.closest('[data-row-key]')?.getAttribute('data-row-key')).toBe('step:notice');
    expect(rowTop(notice)).toBeGreaterThan(rowTop(fold()));
    expect(rowTop(host.querySelector('[data-message-id="notice-step"]'))).toBeGreaterThan(rowTop(notice));

    await toggleFold();
    await flush();
    expect(notices()).toHaveLength(0);
});

test('Show notes keeps what the agent wrote in view and the plugin message in the fold', async () => {
    useUIStore.setState({ activityRenderMode: 'text' });
    await show([...prompt, ...noticeTurn]);
    expect(host.textContent).toContain('Reading the result first.');
    expect(host.textContent).toContain('It lives in auth.ts.');
    expect(notices()).toHaveLength(0);
    expect(host.textContent).not.toContain('Background task DONE');
});

test('the notice follows the extension: a bubble while it is paused, a step again once it is back', async () => {
    await show([...prompt, ...noticeTurn]);
    expect(bubbles()).toHaveLength(1);

    await act(async () => useGuestsStore.setState({ guests: [{ ...extension, enabled: false }] }));
    await flush();
    expect(notices()).toHaveLength(0);
    expect(bubbles()).toHaveLength(2);
    expect(head()?.textContent).toContain('[TASK DONE]');

    await act(async () => useGuestsStore.setState({ guests: [extension] }));
    await flush();
    expect(notices()).toHaveLength(0);
    expect(bubbles()).toEqual(['Find the middleware.']);
    expect(head()?.textContent).toBe('');
});

test('with Activity expanded by default the notice stays the row that opens its turn', async () => {
    useUIStore.setState({ activityRenderMode: 'summary' });
    await show([...prompt, ...noticeTurn]);
    expect(notices()).toHaveLength(1);
    expect(head()?.contains(notices()[0] ?? null)).toBe(true);
    expect(fold()).toBeNull();
});

test('a notice still waiting for its reply shows once, under its own Activity', async () => {
    await show([...prompt, user('notice', NOTICE, 10)]);
    expect(notices()).toHaveLength(1);
    expect(fold()?.contains(notices()[0] ?? null)).toBe(true);
    expect(head()?.contains(notices()[0] ?? null)).toBe(false);
    expect(bubbles()).toEqual(['Find the middleware.']);
});

test('going to a folded notice opens its Activity', async () => {
    await show([...prompt, ...noticeTurn]);
    expect(notices()).toHaveLength(0);
    await act(async () => { ref.current?.scrollToMessageId('notice'); });
    await flush();
    expect(notices()).toHaveLength(1);
    expect(notices()[0]?.id).toBe('message-notice');
});
