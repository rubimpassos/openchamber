import React from 'react';
import { HtmlRenderDocument } from '@/components/chat/message/parts/HtmlRenderDocument';
import { RetainedPageNotice } from '@/components/chat/message/parts/RetainedPageNotice';
import { UiPageFrame, type RenderedPageOrigin } from '@/components/chat/message/parts/UiPageFrame';
import { clampHtmlRenderHeight } from '@/components/chat/message/parts/htmlRender';
import { RetainedPageFailure, RetainedPagePending } from '@/components/chat/message/parts/RetainedPageStatus';
import { retainedDrawing, settledPageAsk, type RetainedDrawing } from '@/components/chat/message/parts/retainedPage';
import { useHtmlPageAnswer } from '@/components/chat/message/parts/useHtmlPageAnswer';
import { useBotArtifactRead } from '@/hooks/useBotArtifactRead';
import { RetainedMarkdownImagesContext } from '@/components/chat/markdown/markdown-media-context';
import type { BotArtifactRead } from '@/lib/bots/artifacts';
import { useI18n } from '@/lib/i18n';
import type { RenderedPageAsk } from '@/lib/opencode/tools';
import { laterPageAsk } from '@/hooks/usePageAsk';
import { useIsCallWaiting } from '@/sync/global-blocking-requests';
import { useLaterPage } from '@/sync/later-pages';

function unreachable(value: never): never {
  throw new TypeError(`Unsupported artifact view: ${JSON.stringify(value)}`);
}

const WAITING: RenderedPageAsk = { kind: 'waiting' };

function usePageStanding({ artifact, page }: BotArtifactRead): RenderedPageAsk {
  const { sessionId, callId } = artifact.source;
  const announced = useIsCallWaiting(sessionId, callId);
  const later = useLaterPage(sessionId, callId);
  const settled = React.useMemo(() => settledPageAsk(page), [page]);
  const fromLater = React.useMemo(() => (later ? laterPageAsk(later) : null), [later]);
  return announced ? WAITING : fromLater ?? settled;
}

function HtmlArtifact({ origin, html, title, ask, readOnly }: {
  readonly origin: RenderedPageOrigin; readonly html: string; readonly title: string;
  readonly ask: RenderedPageAsk; readonly readOnly: boolean;
}) {
  const [height, setHeight] = React.useState(240);
  const resized = React.useCallback((value: number) => setHeight(clampHtmlRenderHeight(value)), []);
  const { answerState, submit, sendDecline, setDeclineInPage, declineButton, status } = useHtmlPageAnswer({
    sessionId: origin.sessionId, callId: origin.callId, ask, readOnly,
  });
  return <>
    <HtmlRenderDocument partId={origin.partId} html={html} title={title}
      className="block w-full border-0 bg-transparent" style={{ height }} answerState={answerState}
      onContentHeight={resized} onSubmit={submit} onDecline={sendDecline} onDeclinePlaced={setDeclineInPage} />
    {declineButton}
    {status}
  </>;
}

function ArtifactBody({ drawing, origin, title, ask, readOnly }: {
  readonly drawing: RetainedDrawing; readonly origin: RenderedPageOrigin; readonly title: string;
  readonly ask: RenderedPageAsk; readonly readOnly: boolean;
}) {
  switch (drawing.format) {
    case 'html':
      return <HtmlArtifact origin={origin} html={drawing.document} title={title} ask={ask} readOnly={readOnly} />;
    case 'ui':
      return <RetainedMarkdownImagesContext.Provider value={drawing.images}>
        <UiPageFrame origin={origin} source={drawing.program} ask={ask} readOnly={readOnly} />
      </RetainedMarkdownImagesContext.Provider>;
    default:
      return unreachable(drawing);
  }
}

function ArtifactDocument({ data, readOnly }: { readonly data: BotArtifactRead; readonly readOnly: boolean }) {
  const { artifact, payload } = data;
  const { t } = useI18n();
  const ask = usePageStanding(data);
  const drawing = React.useMemo(() => retainedDrawing(payload), [payload]);
  const origin = React.useMemo<RenderedPageOrigin>(() => ({
    sessionId: artifact.source.sessionId, callId: artifact.source.callId, partId: artifact.id,
  }), [artifact]);
  return <div className="min-w-0 space-y-3" data-bot-render-artifact={artifact.id}>
    <RetainedPageNotice assets={artifact.incompleteAssets} />
    {readOnly && ask.kind === 'waiting' ? <p className="typography-meta text-muted-foreground">{t('bots.artifacts.readOnly')}</p> : null}
    <ArtifactBody drawing={drawing} origin={origin} title={artifact.title} ask={ask} readOnly={readOnly} />
  </div>;
}

export function BotRenderArtifactView({ projectId, itemId, artifactId, readOnly = false }: {
  readonly projectId: string;
  readonly itemId: string;
  readonly artifactId: string;
  readonly readOnly?: boolean;
}) {
  const read = useBotArtifactRead({ projectId, itemId, artifactId }, true);
  switch (read.kind) {
    case 'loading': return <RetainedPagePending />;
    case 'failed': return <RetainedPageFailure retry={read.retry} />;
    case 'ready': return <ArtifactDocument key={read.data.artifact.id} data={read.data} readOnly={readOnly || Boolean(read.data.pageError)} />;
    default: return unreachable(read);
  }
}
