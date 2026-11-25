import { describe, expect, test } from 'bun:test';

import type { JsonValue, ToolState } from '@/lib/opencode/model';
import { retainedDrawing, retainedPageReference, settledPageAsk } from './retainedPage';

const ID = `artifact_${'b'.repeat(64)}`;
const reference = {
    id: ID, title: 'Latency', kind: 'evidence', createdAt: 1, interaction: 'none', incompleteAssets: [], publication: 'captured',
    source: { sessionId: 'ses-1', callId: 'call-1', producer: { role: 'stage', stage: 'investigation' } },
};
const result = (envelope: Record<string, JsonValue>): ToolState => ({
    status: 'completed', input: {}, output: JSON.stringify(envelope), time: { start: 1, end: 2 },
});
const POLICY = /^<meta http-equiv="Content-Security-Policy" content="[^"]*">/;
type Assets = Parameters<typeof retainedDrawing>[0]['assets'];
const documentOf = (content: string, assets: Assets = []) => {
    const drawing = retainedDrawing({ version: 1, body: { format: 'html', content }, assets });
    if (drawing.format !== 'html') throw new Error('An HTML page draws as a document');
    return drawing.document;
};
const opensWithPolicy = (markup: string) => POLICY.test(markup);

describe('the snapshot a render result names', () => {
    test('is read from a completed, accepted result and from nothing else', () => {
        const accepted = { schemaVersion: 1, ok: true, action: 'render.page', data: { title: 'Latency', artifact: reference } };
        expect(retainedPageReference(result(accepted))?.id).toBe(ID);
        expect(retainedPageReference(result({ ...accepted, ok: false }))).toBeNull();
        expect(retainedPageReference(result({ ...accepted, data: { title: 'Latency' } }))).toBeNull();
        expect(retainedPageReference(result({ ...accepted, data: { artifact: { ...reference, id: '../other' } } }))).toBeNull();
        expect(retainedPageReference({ status: 'running', input: {}, time: { start: 1 }, metadata: { artifact: reference } })).toBeNull();
    });

    for (const status of ['running', 'completed', 'error'] as const) test(`reads capture metadata while the call is ${status}`, () => {
        const metadata = { openchamber: { artifact: reference } };
        const state: ToolState = status === 'running'
            ? { status, input: {}, metadata, time: { start: 1 } }
            : status === 'error'
                ? { status, input: {}, metadata, error: 'Interrupted', time: { start: 1, end: 2 } }
                : { status, input: {}, metadata, output: '', time: { start: 1, end: 2 } };
        expect(retainedPageReference(state)?.id).toBe(ID);
    });
});

describe('a retained HTML document', () => {
    test('puts its policy ahead of every element, whatever opens the page', () => {
        // Given pages that open with a doctype, with a comment before it, and with neither.
        const plain = documentOf('<!DOCTYPE html><img src="/a.png">');
        const commented = documentOf('\n<!-- <img src="/early.png"> -->\n<!doctype html>\n<html><img src="/a.png">');
        const fragment = documentOf('<img src="/a.png"><!doctype html>');

        // Then the doctype still leads, so the page keeps its rendering mode, and the policy follows it at once.
        expect(opensWithPolicy(plain.slice('<!DOCTYPE html>'.length))).toBe(true);
        expect(opensWithPolicy(commented.slice(commented.indexOf('<!doctype html>') + '<!doctype html>'.length))).toBe(true);
        expect(opensWithPolicy(fragment)).toBe(true);
    });

    test('replaces only the images it holds', () => {
        const document = documentOf('<img src="/kept.png"><img src="/lost.png">', [
            { source: '/kept.png', status: 'ready', mime: 'image/png', data: 'AAAA' },
            { source: '/lost.png', status: 'missing' },
        ]);
        expect(document).toContain('<img src="data:image/png;base64,AAAA"><img src="/lost.png">');
    });
});

describe('where a retained page stood', () => {
    test('carries how its question settled', () => {
        expect(settledPageAsk({ kind: 'answered', summary: 'B', data: { pick: 'b' }, undelivered: true }))
            .toEqual({ kind: 'answered', summary: 'B', data: { pick: 'b' }, undelivered: true });
        expect(settledPageAsk({ kind: 'declined' })).toEqual({ kind: 'declined' });
        expect(settledPageAsk({ kind: 'answered-in-chat' })).toEqual({ kind: 'answered-in-chat' });
    });

    test('never opens a question from the read alone', () => {
        const shown = { kind: 'show' } as const;
        expect(settledPageAsk({ kind: 'waiting' })).toEqual(shown);
        expect(settledPageAsk({ kind: 'waiting', later: true })).toEqual(shown);
        expect(settledPageAsk({ kind: 'later' })).toEqual(shown);
        expect(settledPageAsk(null)).toEqual(shown);
        expect(settledPageAsk(undefined)).toEqual(shown);
    });
});
