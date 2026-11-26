import React from 'react';
import { HtmlRenderDocument } from '@/components/chat/message/parts/HtmlRenderDocument';
import { RetainedPageNotice } from '@/components/chat/message/parts/RetainedPageNotice';
import { UiPageFrame, type RenderedPageOrigin } from '@/components/chat/message/parts/UiPageFrame';
import { clampHtmlRenderHeight } from '@/components/chat/message/parts/htmlRender';
import { RetainedPageFailure, RetainedPagePending } from '@/components/chat/message/parts/RetainedPageStatus';
import { retainedDrawing, settledPageAsk, type RetainedDrawing } from '@/components/chat/message/parts/retainedPage';
import { useHtmlPageAnswer } from '@/components/chat/message/parts/useHtmlPageAnswer';
import { useUiBlockComponent } from '@/components/chat/uiBlocks/useUiBlockComponent';
import { useBotArtifactRead } from '@/hooks/useBotArtifactRead';
import { useOnDemandComponent } from '@/hooks/useOnDemandComponent';
import { useCommittedLayoutReady } from '@/hooks/useCommittedLayoutReady';
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
const PROVISIONAL_HEIGHT = 240;

const loadUiRenderer = () => useUiBlockComponent.load();

type Staging = {
  readonly preparing?: boolean;
  readonly onReady?: () => void;
  readonly onLoadFailed?: () => void;
};

function usePageStanding({ artifact, page }: BotArtifactRead): RenderedPageAsk {
  const { sessionId, callId } = artifact.source;
  const announced = useIsCallWaiting(sessionId, callId);
  const later = useLaterPage(sessionId, callId);
  const settled = React.useMemo(() => settledPageAsk(page), [page]);
  const fromLater = React.useMemo(() => (later ? laterPageAsk(later) : null), [later]);
  return announced ? WAITING : fromLater ?? settled;
}

function HtmlArtifact({ origin, html, title, ask, readOnly, preparing, onReady }: Staging & {
  readonly origin: RenderedPageOrigin; readonly html: string; readonly title: string;
  readonly ask: RenderedPageAsk; readonly readOnly: boolean;
}) {
  const [height, setHeight] = React.useState<number | null>(null);
  const resized = React.useCallback((value: number) => setHeight(clampHtmlRenderHeight(value)), []);
  const { answerState, submit, sendDecline, setDeclineInPage, declineButton, status } = useHtmlPageAnswer({
    sessionId: origin.sessionId, callId: origin.callId, ask, readOnly,
  });
  useCommittedLayoutReady(height !== null, onReady);
  return <>
    <HtmlRenderDocument partId={origin.partId} html={html} title={title}
      className="block w-full border-0 bg-transparent" style={{ height: height ?? PROVISIONAL_HEIGHT }} answerState={answerState}
      onContentHeight={resized} onSubmit={preparing ? undefined : submit} onDecline={preparing ? undefined : sendDecline}
      onDeclinePlaced={setDeclineInPage} />
    {declineButton}
    {status}
  </>;
}

function UiArtifact({ origin, drawing, ask, readOnly, onReady, onLoadFailed }: Staging & {
  readonly origin: RenderedPageOrigin; readonly drawing: Extract<RetainedDrawing, { readonly format: 'ui' }>;
  readonly ask: RenderedPageAsk; readonly readOnly: boolean;
}) {
  const [drawsSource, drawSource] = React.useReducer(() => true, false);
  const renderer = useOnDemandComponent(!drawsSource, loadUiRenderer, onLoadFailed ?? drawSource);
  useCommittedLayoutReady(Boolean(renderer || drawsSource), onReady);
  if (!renderer && !drawsSource) return <RetainedPagePending />;
  return <RetainedMarkdownImagesContext.Provider value={drawing.images}>
    <UiPageFrame origin={origin} source={drawing.program} ask={ask} readOnly={readOnly} />
  </RetainedMarkdownImagesContext.Provider>;
}

function ArtifactBody({ drawing, origin, title, ask, readOnly, ...staging }: Staging & {
  readonly drawing: RetainedDrawing; readonly origin: RenderedPageOrigin; readonly title: string;
  readonly ask: RenderedPageAsk; readonly readOnly: boolean;
}) {
  switch (drawing.format) {
    case 'html':
      return <HtmlArtifact origin={origin} html={drawing.document} title={title} ask={ask} readOnly={readOnly} {...staging} />;
    case 'ui':
      return <UiArtifact origin={origin} drawing={drawing} ask={ask} readOnly={readOnly} {...staging} />;
    default:
      return unreachable(drawing);
  }
}

function ArtifactDocument({ data, readOnly, ...staging }: Staging & {
  readonly data: BotArtifactRead; readonly readOnly: boolean;
}) {
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
    <ArtifactBody drawing={drawing} origin={origin} title={artifact.title} ask={ask} readOnly={readOnly} {...staging} />
  </div>;
}

export function BotRenderArtifactView({ projectId, itemId, artifactId, readOnly = false, onRetry, ...staging }: Staging & {
  readonly projectId: string;
  readonly itemId: string;
  readonly artifactId: string;
  readonly readOnly?: boolean;
  readonly onRetry?: (retry: () => void) => void;
}) {
  const read = useBotArtifactRead({ projectId, itemId, artifactId }, true);
  useCommittedLayoutReady(read.kind === 'failed', staging.onReady);
  switch (read.kind) {
    case 'loading': return <RetainedPagePending />;
    case 'failed': return <RetainedPageFailure cause={read.cause} retry={onRetry ? () => onRetry(read.retry) : read.retry} />;
    case 'ready': return <ArtifactDocument key={read.data.artifact.id} data={read.data} readOnly={readOnly || Boolean(read.data.pageError)} {...staging} />;
    default: return unreachable(read);
  }
}
