import React from 'react';
import { useI18n } from '@/lib/i18n';
import type { ChatQuoteAnchor } from '@/lib/chatQuoteAnchor';
import { openExternalUrl } from '@/lib/url';
import { dispatchFrameScroll } from '@/components/chat/lib/scroll/timelineScrollIntent';
import { dispatchFrameSelection, frameRectInApp } from '../frameSelection';
import {
  clearOtherPageSelections, emitPageMarkClick, getPageMarks, registerPageFrame,
  subscribePageMarks, type PageFrameHandle,
} from '../pageQuoteBridge';
import {
  buildHtmlRenderDocument, htmlRenderAnswerStateMessage, htmlRenderClearSelectionMessage,
  htmlRenderMarksMessage, htmlRenderPointerMessage, htmlRenderRevealMessage, htmlRenderSubmitReply,
  htmlRenderThemeMessage, readHtmlRenderFrameMessage,
  type HtmlRenderAnswerState, type HtmlRenderKeyChord, type HtmlRenderSubmission,
} from './htmlRender';
import { useHtmlRenderTheme } from './useHtmlRenderTheme';

const NO_ANSWER: HtmlRenderAnswerState = { waiting: false, answer: null };
const NO_RECT = { top: 0, left: 0, width: 0, height: 0 };

function replayKeyChord(frame: HTMLIFrameElement, chord: HtmlRenderKeyChord) {
  if (chord.key === 'Escape' && !chord.metaKey && !chord.ctrlKey && !frame.closest('[role="dialog"]')) return;
  for (const type of ['keydown', 'keyup'] as const) {
    frame.dispatchEvent(new KeyboardEvent(type, { ...chord, bubbles: true, cancelable: true, composed: true }));
  }
}

interface HtmlRenderDocumentProps {
  partId: string;
  html: string;
  title: string;
  className?: string;
  style?: React.CSSProperties;
  contained?: boolean;
  answerState?: HtmlRenderAnswerState;
  onSubmit?: (submission: HtmlRenderSubmission) => Promise<void>;
  onDecline?: () => void;
  onDeclinePlaced?: (placed: boolean) => void;
  onContentHeight?: (height: number) => void;
  frameRef?: React.RefObject<HTMLIFrameElement | null>;
}

export function HtmlRenderDocument({
  partId, html, title, className, style, contained = false, answerState = NO_ANSWER,
  onSubmit, onDecline, onDeclinePlaced, onContentHeight, frameRef: outerFrameRef,
}: HtmlRenderDocumentProps) {
  const { t } = useI18n();
  const theme = useHtmlRenderTheme();
  const [initialTheme] = React.useState(theme);
  const [initialAnswerState] = React.useState(answerState);
  const [declineLabel] = React.useState(() => t('chat.htmlRender.decline'));
  const srcDoc = React.useMemo(
    () => buildHtmlRenderDocument(html, initialTheme, { contained, answerState: initialAnswerState, declineLabel }),
    [contained, declineLabel, html, initialAnswerState, initialTheme],
  );
  const frameRef = React.useRef<HTMLIFrameElement>(null);
  const setFrame = React.useCallback((node: HTMLIFrameElement | null) => {
    frameRef.current = node;
    if (outerFrameRef) outerFrameRef.current = node;
  }, [outerFrameRef]);
  const handleRef = React.useRef<PageFrameHandle | null>(null);
  const loadedRef = React.useRef(false);
  const pendingRevealRef = React.useRef<ChatQuoteAnchor | null>(null);
  const postState = React.useCallback(() => {
    frameRef.current?.contentWindow?.postMessage(htmlRenderThemeMessage(theme), '*');
    frameRef.current?.contentWindow?.postMessage(htmlRenderAnswerStateMessage(answerState), '*');
  }, [answerState, theme]);
  React.useEffect(postState, [postState]);
  const submitRef = React.useRef({ answerState, onSubmit, onDecline, onDeclinePlaced });
  React.useLayoutEffect(() => {
    submitRef.current = { answerState, onSubmit, onDecline, onDeclinePlaced };
  }, [answerState, onSubmit, onDecline, onDeclinePlaced]);
  const postMarks = React.useCallback(() => {
    frameRef.current?.contentWindow?.postMessage(htmlRenderMarksMessage(getPageMarks(partId)), '*');
  }, [partId]);
  React.useEffect(() => {
    postMarks();
    return subscribePageMarks(partId, postMarks);
  }, [partId, postMarks]);
  const pointerOverRef = React.useRef(false);
  const postPointer = React.useCallback((over: boolean) => {
    pointerOverRef.current = over;
    frameRef.current?.contentWindow?.postMessage(htmlRenderPointerMessage(over), '*');
  }, []);
  const [shown, setShown] = React.useState(false);
  const handleLoad = React.useCallback(() => {
    setShown(true);
    loadedRef.current = true;
    postState();
    postMarks();
    if (pointerOverRef.current) postPointer(true);
    const pending = pendingRevealRef.current;
    pendingRevealRef.current = null;
    if (pending) frameRef.current?.contentWindow?.postMessage(htmlRenderRevealMessage(pending), '*');
  }, [postMarks, postPointer, postState]);
  React.useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const handle: PageFrameHandle = {
      partId,
      reveal: (anchor) => {
        frame.scrollIntoView({ block: 'center', inline: 'nearest' });
        if (loadedRef.current) frame.contentWindow?.postMessage(htmlRenderRevealMessage(anchor), '*');
        else pendingRevealRef.current = anchor;
      },
      clearSelection: (dismiss = true) => {
        frame.contentWindow?.postMessage(htmlRenderClearSelectionMessage(), '*');
        dispatchFrameSelection(frame, { text: '', rect: NO_RECT, dismiss });
      },
    };
    handleRef.current = handle;
    const unregister = registerPageFrame(handle);
    return () => {
      unregister();
      handleRef.current = null;
    };
  }, [partId]);
  React.useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const frame = frameRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const message = readHtmlRenderFrameMessage(event);
      if (message?.kind === 'size') {
        setShown(true);
        onContentHeight?.(message.height === 0 ? frame.clientHeight : message.height);
      }
      if (message?.kind === 'open-link') void openExternalUrl(message.url);
      if (message?.kind === 'key') replayKeyChord(frame, message.chord);
      if (message?.kind === 'scroll') dispatchFrameScroll(frame, message.direction);
      if (message?.kind === 'submit') {
        const reply = (error?: string) => frame.contentWindow?.postMessage(htmlRenderSubmitReply(message.id, error), '*');
        const { answerState: current, onSubmit: deliver } = submitRef.current;
        if (!deliver || !current.waiting) return reply('This page is not waiting for an answer');
        if (navigator.userActivation && !navigator.userActivation.isActive) return reply('openchamber.submit works only from a click');
        if (!message.submission.summary) return reply('summary is required: the choice in a few words');
        deliver(message.submission).then(() => reply(), (error) => reply(error instanceof Error ? error.message : String(error)));
      }
      if (message?.kind === 'decline') {
        const { answerState: current, onDecline: decline } = submitRef.current;
        if (!decline || !current.waiting || (navigator.userActivation && !navigator.userActivation.isActive)) {
          frame.contentWindow?.postMessage(htmlRenderAnswerStateMessage(current), '*');
        } else decline();
      }
      if (message?.kind === 'decline-placed') submitRef.current.onDeclinePlaced?.(message.placed);
      if (message?.kind === 'selection') {
        const handle = handleRef.current;
        if (message.text || message.dismiss) {
          window.getSelection()?.removeAllRanges();
          if (handle) clearOtherPageSelections(handle, Boolean(message.text));
        }
        dispatchFrameSelection(frame, {
          text: message.text, rect: message.rect,
          anchor: message.anchor ? { ...message.anchor, page: { partId } } : undefined,
          clear: handle?.clearSelection,
        });
      }
      if (message?.kind === 'selection-escape') handleRef.current?.clearSelection();
      if (message?.kind === 'mark-click') emitPageMarkClick({
        partId, markId: message.id, measure: () => frameRectInApp(frame, message.rect),
        portalTarget: frame.closest<HTMLElement>('[data-slot="dialog-content"]'),
      });
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [onContentHeight, partId]);
  return <iframe ref={setFrame} title={title} srcDoc={srcDoc} sandbox="allow-scripts allow-forms"
    onLoad={handleLoad} onPointerEnter={() => postPointer(true)} onPointerLeave={() => postPointer(false)}
    className={className} style={{ ...style, colorScheme: theme.appearance, opacity: shown ? undefined : 0 }} />;
}
