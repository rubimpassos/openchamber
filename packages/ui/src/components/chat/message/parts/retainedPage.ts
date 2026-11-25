import { z } from 'zod';

import { botArtifactReferenceSchema, type BotArtifactRead, type BotArtifactReference } from '@/lib/bots/artifacts';
import type { ToolState } from '@/lib/opencode/model';
import type { RenderedPageAsk } from '@/lib/opencode/tools';
import type { RetainedMarkdownImages } from '../../markdown/markdown-media-context';
import { parseOpenChamberEnvelope } from './openChamberToolEnvelope';
import { inlineRenderPageImages } from './renderPageImages';

const renderResultSchema = z.object({ artifact: botArtifactReferenceSchema });
const renderMetadataSchema = z.object({ openchamber: renderResultSchema });

export function retainedPageReference(state: ToolState): BotArtifactReference | null {
    if ('metadata' in state) {
        const captured = renderMetadataSchema.safeParse(state.metadata);
        if (captured.success) return captured.data.openchamber.artifact;
    }
    if (state.status !== 'completed') return null;
    const envelope = parseOpenChamberEnvelope(state.output);
    if (!envelope?.ok) return null;
    return renderResultSchema.safeParse(envelope.data).data?.artifact ?? null;
}

const retainedImages = (payload: BotArtifactRead['payload']): RetainedMarkdownImages => new Map(
    payload.assets.flatMap((asset) => (asset.status === 'ready'
        ? [[asset.source, `data:${asset.mime};base64,${asset.data}`] as const]
        : [])),
);

const RETAINED_PAGE_POLICY = [
    "default-src 'none'",
    "script-src 'unsafe-inline' 'unsafe-eval'",
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'media-src data: blob:',
    'font-src data:',
    "form-action 'none'",
].join('; ');
const POLICY_MARKUP = `<meta http-equiv="Content-Security-Policy" content="${RETAINED_PAGE_POLICY}">`;

function doctypeEnd(html: string): number {
    const lead = /\s+|<!--[\s\S]*?-->/y;
    let at = 0;
    while (lead.test(html)) at = lead.lastIndex;
    const doctype = /<!doctype[^>]*>/iy;
    doctype.lastIndex = at;
    return doctype.test(html) ? doctype.lastIndex : 0;
}

function underPolicy(html: string): string {
    const at = doctypeEnd(html);
    return `${html.slice(0, at)}${POLICY_MARKUP}${html.slice(at)}`;
}

function unreachable(value: never): never {
    throw new TypeError(`Unknown retained page: ${JSON.stringify(value)}`);
}

export type RetainedDrawing =
    | { readonly format: 'html'; readonly document: string; readonly shareable: string }
    | { readonly format: 'ui'; readonly images: RetainedMarkdownImages; readonly program: string };

export function retainedDrawing(payload: BotArtifactRead['payload']): RetainedDrawing {
    const images = retainedImages(payload);
    switch (payload.body.format) {
        case 'html': {
            const shareable = inlineRenderPageImages(payload.body.content, images);
            return { format: 'html', document: underPolicy(shareable), shareable };
        }
        case 'ui': return { format: 'ui', images, program: payload.body.content };
        default: return unreachable(payload.body);
    }
}

export function settledPageAsk(page: BotArtifactRead['page']): RenderedPageAsk {
    if (!page) return { kind: 'show' };
    switch (page.kind) {
        case 'answered': {
            const answered = { kind: 'answered', summary: page.summary, data: page.data } as const;
            return page.undelivered ? { ...answered, undelivered: true } : answered;
        }
        case 'declined':
        case 'not-drawn':
            return page.undelivered ? { kind: page.kind, undelivered: true } : { kind: page.kind };
        case 'unanswered':
        case 'answered-in-chat':
        case 'chat-sent-earlier':
            return { kind: page.kind };
        case 'show':
        case 'waiting':
        case 'later':
            return { kind: 'show' };
        default:
            return unreachable(page);
    }
}
