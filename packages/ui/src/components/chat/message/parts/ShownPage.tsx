import React from 'react';

import { usePageAsk } from '@/hooks/usePageAsk';
import type { BotArtifactRead } from '@/lib/bots/artifacts';
import { useI18n } from '@/lib/i18n';
import type { ToolPart } from '@/lib/opencode/model';
import { renderedPage, type RenderedPageAsk, type RenderedPageShare } from '@/lib/opencode/tools';
import { RetainedMarkdownImagesContext } from '../../markdown/markdown-media-context';
import { SharedPageCard } from '../../sharePages/SharedPageCard';
import { HtmlRenderFrame } from './HtmlRenderFrame';
import { retainedDrawing, type RetainedDrawing } from './retainedPage';
import { RetainedPageNotice } from './RetainedPageNotice';
import { RetainedPageFailure, RetainedPagePending } from './RetainedPageStatus';
import { UiPageFrame, type RenderedPageOrigin } from './UiPageFrame';
import { useRetainedPage } from './useRetainedPage';

type Host = {
    readonly part: ToolPart;
    readonly origin: RenderedPageOrigin;
    readonly title: string;
    readonly ask: RenderedPageAsk;
};

function unreachable(value: never): never {
    throw new TypeError(`Unknown retained page: ${JSON.stringify(value)}`);
}

function LivePage({ part, origin, title, ask, html, ui }: Host & { readonly html: string; readonly ui?: string }) {
    return ui
        ? <UiPageFrame origin={origin} source={ui} ask={ask} />
        : <HtmlRenderFrame part={part} html={html} title={title} ask={ask} />;
}

function RetainedBody({ part, origin, title, ask, drawing }: Host & { readonly drawing: RetainedDrawing }) {
    switch (drawing.format) {
        case 'html':
            return <HtmlRenderFrame part={part} html={drawing.document} title={title} ask={ask} retained />;
        case 'ui':
            return (
                <RetainedMarkdownImagesContext.Provider value={drawing.images}>
                    <UiPageFrame origin={origin} source={drawing.program} ask={ask} />
                </RetainedMarkdownImagesContext.Provider>
            );
        default:
            return unreachable(drawing);
    }
}

type Sharing = { readonly title: string; readonly share: RenderedPageShare };

function RetainedPage({ data, sharing, ...host }: Host & {
    readonly data: BotArtifactRead;
    readonly sharing: Sharing | null;
}) {
    const { artifact, payload } = data;
    const drawing = React.useMemo(() => retainedDrawing(payload), [payload]);
    const plainPage = (
        <>
            <RetainedPageNotice assets={artifact.incompleteAssets} className="my-2" />
            <RetainedBody {...host} drawing={drawing} />
        </>
    );
    if (!sharing) return plainPage;
    switch (drawing.format) {
        case 'html':
            return <SharedPageCard part={host.part} page={{ ...sharing, html: payload.body.content, retainedHtml: drawing.shareable }} plainPage={plainPage} />;
        case 'ui':
            return <SharedPageCard part={host.part} page={{ ...sharing, html: '', ui: drawing.program }} plainPage={plainPage} />;
        default:
            return unreachable(drawing);
    }
}

export function ShownPage({ part }: { part: ToolPart }) {
    const { t } = useI18n();
    const page = React.useMemo(() => renderedPage(part.tool, part.state), [part.tool, part.state]);
    const ask = usePageAsk(part, page?.ask);
    const retained = useRetainedPage(part, Boolean(page && ask));
    const origin = React.useMemo<RenderedPageOrigin>(() => ({
        sessionId: part.sessionID, callId: part.callID, partId: part.id, messageId: part.messageID,
    }), [part.sessionID, part.callID, part.id, part.messageID]);
    if (!page || !ask) return null;
    const { share } = page;
    const host: Host = { part, origin, title: page.title || t('chat.htmlRender.untitled'), ask };
    switch (retained.kind) {
        case 'live': {
            const plainPage = <LivePage {...host} html={page.html} ui={page.ui} />;
            return share ? <SharedPageCard part={part} page={{ ...page, share }} plainPage={plainPage} /> : plainPage;
        }
        case 'pending':
            return <RetainedPagePending className="my-2" />;
        case 'failed':
            return <RetainedPageFailure cause={retained.cause} retry={retained.retry} className="my-2" />;
        case 'ready':
            return <RetainedPage {...host} data={retained.data} sharing={share ? { title: page.title, share } : null} />;
        default:
            return unreachable(retained);
    }
}
