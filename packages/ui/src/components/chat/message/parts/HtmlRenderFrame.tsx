import React from 'react';

import { toast } from '@/components/ui';
import { ToolbarTooltipButton } from '@/components/ui/action-toolbar';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useFrameAnnotation } from '@/components/browser/useFrameAnnotation';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import type { BrowserAnnotationPayload } from '@/lib/browser/contract';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import type { ToolPart } from '@/lib/opencode/model';
import type { RenderedPageAsk } from '@/lib/opencode/tools';
import { useConfigStore } from '@/stores/useConfigStore';
import { dispatchPageWaiting } from '@/components/chat/lib/scroll/timelineScrollIntent';
import { useChatSurfaceMode } from '@/components/chat/useChatSurfaceMode';
import { TextSelectionMenu } from '../TextSelectionMenu';
import {
    HTML_RENDER_MIN_HEIGHT,
    buildHtmlRenderDocument,
    clampHtmlRenderHeight,
    htmlRenderFileName,
    type HtmlRenderAnswerState,
    type HtmlRenderSubmission,
} from './htmlRender';
import { useRenderPageHtml } from './renderPageImages';
import { saveFile } from './saveFile';
import { useHtmlRenderTheme } from './useHtmlRenderTheme';
import { pageBlocksTurn } from '@/hooks/usePageAsk';
import { HtmlRenderDocument } from './HtmlRenderDocument';
import { useHtmlPageAnswer } from './useHtmlPageAnswer';

const MAX_REMEMBERED_HEIGHTS = 500;
const rememberedHeights = new Map<string, number>();
const rememberHeight = (id: string, height: number) => {
    rememberedHeights.delete(id);
    rememberedHeights.set(id, height);
    if (rememberedHeights.size > MAX_REMEMBERED_HEIGHTS) {
        const oldest = rememberedHeights.keys().next().value;
        if (oldest !== undefined) rememberedHeights.delete(oldest);
    }
};

function FullscreenPage({ partId, messageId, html, title, initialHeight, answerState, onSubmit, onDecline, decline }: {
    partId: string;
    messageId: string;
    html: string;
    title: string;
    initialHeight: number;
    answerState: HtmlRenderAnswerState;
    onSubmit: (submission: HtmlRenderSubmission) => Promise<void>;
    onDecline: () => void;
    decline: React.ReactNode;
}) {
    const [height, setHeight] = React.useState(initialHeight);
    const handleContentHeight = React.useCallback((contentHeight: number) => setHeight(Math.ceil(contentHeight)), []);
    return (
        <PageSelectionScope messageId={messageId} className="flex min-h-0 flex-col px-5 pb-5">
            <HtmlRenderDocument
                partId={partId}
                html={html}
                title={title}
                className="block min-h-0 w-full shrink border-0 bg-transparent"
                style={{ height }}
                contained
                answerState={answerState}
                onSubmit={onSubmit}
                onDecline={onDecline}
                onContentHeight={handleContentHeight}
            />
            {decline ? <div className="mt-2 shrink-0">{decline}</div> : null}
        </PageSelectionScope>
    );
}

function PageSelectionScope({
    messageId,
    className,
    style,
    partId,
    children,
}: {
    messageId: string;
    className?: string;
    style?: React.CSSProperties;
    partId?: string;
    children: React.ReactNode;
}) {
    const scopeRef = React.useRef<HTMLDivElement>(null);
    const chatSurfaceMode = useChatSurfaceMode();
    const showMessageTTSButtons = useConfigStore((state) => state.showMessageTTSButtons);
    return (
        <div ref={scopeRef} className={className} style={style} data-html-render={partId}>
            {children}
            <TextSelectionMenu
                containerRef={scopeRef}
                readingKey={messageId}
                canReadAloud={chatSurfaceMode !== 'mini-chat' && showMessageTTSButtons}
                frameSelections
            />
        </div>
    );
}

interface HtmlRenderFrameProps {
    part: ToolPart;
    html: string;
    title: string;
    ask: RenderedPageAsk;
    retained?: boolean;
}

export function HtmlRenderFrame({ part, html, title, ask, retained = false }: HtmlRenderFrameProps) {
    const { t } = useI18n();
    const partId = part.id;
    const messageId = part.messageID;
    const theme = useHtmlRenderTheme();
    const liveHtml = useRenderPageHtml(part, retained ? '' : html);
    const loadedHtml = retained ? html : liveHtml;
    const pageHtml = loadedHtml ?? html;
    const [height, setHeight] = React.useState(() => rememberedHeights.get(partId) ?? HTML_RENDER_MIN_HEIGHT);
    const [fullscreen, setFullscreen] = React.useState(false);

    const frameRef = React.useRef<HTMLIFrameElement>(null);
    const directory = useEffectiveDirectory() ?? '';
    const describePage = React.useCallback((payload: BrowserAnnotationPayload): BrowserAnnotationPayload => (
        { ...payload, pageUrl: '', pageTitle: title }
    ), [title]);
    const annotation = useFrameAnnotation({
        frameRef,
        directory,
        pageKey: partId,
        intro: t('chat.htmlRender.annotate.intro'),
        describePage,
    });
    const canAnnotate = !isVSCodeRuntime() && loadedHtml !== null;

    const handleContentHeight = React.useCallback((contentHeight: number) => {
        const next = clampHtmlRenderHeight(contentHeight);
        rememberHeight(partId, next);
        setHeight(next);
    }, [partId]);

    const isMobile = useUIStore((state) => state.isMobile);
    const canDownload = !isVSCodeRuntime();
    const handleDownload = React.useCallback(async () => {
        const fileName = htmlRenderFileName(title);
        const file = new File([buildHtmlRenderDocument(pageHtml, theme)], fileName, { type: 'text/html' });
        try {
            await saveFile(file);
        } catch {
            toast.error(t('chat.htmlRender.downloadFailed'));
        }
    }, [pageHtml, t, theme, title]);

    const {
        answerState, submit: handleSubmit, sendDecline, setDeclineInPage, waiting, declineButton, status,
    } = useHtmlPageAnswer({ sessionId: part.sessionID, callId: part.callID, ask });
    const blocking = waiting && pageBlocksTurn(ask);
    const blockRef = React.useRef<HTMLDivElement>(null);
    React.useEffect(() => {
        if (blocking) dispatchPageWaiting(blockRef.current);
    }, [height, blocking]);

    return (
        <div ref={blockRef} className="group/html-render my-2" data-waiting-page={blocking ? partId : undefined}>
        {isMobile ? null : (
            <div className={cn(
                'flex h-6 items-center justify-end gap-0.5 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/html-render:opacity-100 pointer-coarse:opacity-100',
                annotation.isAnnotating && 'opacity-100',
            )}>
                {canAnnotate ? (
                    <ToolbarTooltipButton
                        label={t('contextPanel.browser.annotate.toggle')}
                        icon="markup"
                        pressed={annotation.isAnnotating}
                        onClick={annotation.toggle}
                    />
                ) : null}
                <ToolbarTooltipButton label={t('chat.htmlRender.fullscreen')} icon="fullscreen" onClick={() => setFullscreen(true)} />
                {canDownload ? (
                    <ToolbarTooltipButton label={t('chat.htmlRender.download')} icon="download" onClick={() => { void handleDownload(); }} />
                ) : null}
            </div>
        )}
        <PageSelectionScope messageId={messageId} partId={partId} className="relative" style={{ height }}>
            {loadedHtml === null ? null : (
                <HtmlRenderDocument
                    partId={partId}
                    html={loadedHtml}
                    title={title}
                    className="block size-full border-0 bg-transparent"
                    answerState={answerState}
                    onSubmit={handleSubmit}
                    onDecline={sendDecline}
                    onDeclinePlaced={setDeclineInPage}
                    onContentHeight={handleContentHeight}
                    frameRef={frameRef}
                />
            )}
            {isMobile ? null : (
                <>
                    <Dialog open={fullscreen} onOpenChange={setFullscreen}>
                        <DialogContent className="max-w-[min(72rem,100%)] gap-0 overflow-hidden bg-background p-0">
                            <DialogTitle className="truncate px-5 py-4 pe-12">{title}</DialogTitle>
                            {fullscreen ? (
                                <FullscreenPage
                                    partId={partId}
                                    messageId={messageId}
                                    html={pageHtml}
                                    title={title}
                                    initialHeight={height}
                                    answerState={answerState}
                                    onSubmit={handleSubmit}
                                    onDecline={sendDecline}
                                    decline={declineButton}
                                />
                            ) : null}
                        </DialogContent>
                    </Dialog>
                </>
            )}
        </PageSelectionScope>
        {declineButton ? <div className="mt-2">{declineButton}</div> : null}
        {status}
        </div>
    );
}
