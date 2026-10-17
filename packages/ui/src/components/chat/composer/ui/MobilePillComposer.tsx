/**
 * The collapsed mobile composer.
 *
 * With the keyboard down the composer is a pill: attachments, a one-line
 * preview of the draft, and a mic. Tapping anywhere in it expands the real
 * composer and raises the keyboard in the same gesture — which is why the
 * expand handler must run synchronously from the tap rather than from an
 * effect.
 *
 * With content, the inner end slot sends while the session is idle. While it
 * is running, abort keeps that slot and a queue action appears just before it,
 * inside the pill.
 */

import React, { useState } from 'react';
import { KEYBOARD_EASING_CSS, KEYBOARD_HIDE_MS } from '@/lib/mobileKeyboardTiming';
import type { SourceControlProvider } from '@/lib/api/types';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { StopIcon } from '@/components/icons/StopIcon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/useConfigStore';
import { isVSCodeRuntime } from '@/lib/desktop';
import { isDictationCaptureSupported } from '@/lib/dictation/use-dictation-audio-source';
import { ComposerAttachmentControls } from './ComposerAttachmentControls';
import { MobileComposerHandle } from './MobileComposerHandle';
import { useMobileComposerFoldStore } from '../state/mobileComposerFold';

export interface MobilePillComposerProps {
    message: string;
    sessionId: string | null;
    newSessionDraftOpen: boolean;
    hasContent: boolean;
    isVSCode: boolean;
    canAbort: boolean;
    footerIconButtonClass: string;
    iconSizeClass: string;
    sendIconSizeClass: string;
    stopIconSizeClass: string;
    /** The composer's top rows (goal, queue, hints, suggested follow-up), inside the pill. */
    topRow?: React.ReactNode;
    /** Attached files, shown inside the pill above the draft line. */
    attachments?: React.ReactNode;
    /** Rendered as the pill's own last row (mobile model/agent controls). */
    bottomRow?: React.ReactNode;
    onExpand: () => void;
    onPrimaryAction: () => void;
    /** While a turn runs, the trailing action queues, as the expanded composer does. */
    onQueueMessage: () => void;
    onPickLocalFiles: () => void;
    onOpenGitHubPicker: () => void;
    /** The host the project's issues and change requests come from. */
    repositoryProvider?: SourceControlProvider;
    showLinearPicker?: boolean;
    onOpenLinearPicker?: () => void;
    onOpenAttachSheet: () => void;
    onStartDictation: () => void;
    onAbort: () => void;
}

/**
 * Folding swaps the pill's contents in one commit; this tweens the glass box
 * from its last measured height to the new one, the way the pill/composer
 * morph does, and fades the revealed rows in. The height is kept fresh by a
 * ResizeObserver, so the effect that runs right after the fold commits still
 * holds the height from before it.
 */
function useFoldTween(boxRef: React.RefObject<HTMLDivElement | null>, folded: boolean) {
    const lastHeightRef = React.useRef<number | null>(null);
    const firstRunRef = React.useRef(true);
    React.useLayoutEffect(() => {
        const box = boxRef.current;
        if (!box || !globalThis.ResizeObserver) return;
        const observer = new ResizeObserver(() => { lastHeightRef.current = box.offsetHeight; });
        observer.observe(box);
        lastHeightRef.current = box.offsetHeight;
        return () => observer.disconnect();
    }, [boxRef]);
    React.useLayoutEffect(() => {
        if (firstRunRef.current) {
            firstRunRef.current = false;
            return;
        }
        const box = boxRef.current;
        const from = lastHeightRef.current;
        if (!box || from === null || window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return;
        const to = box.offsetHeight;
        if (Math.abs(to - from) < 2) return;
        const timing = { duration: KEYBOARD_HIDE_MS, easing: KEYBOARD_EASING_CSS };
        box.style.overflow = 'hidden';
        const tween = box.animate([{ height: `${from}px` }, { height: `${to}px` }], timing);
        const release = () => { box.style.overflow = ''; };
        tween.onfinish = release;
        tween.oncancel = release;
        if (!folded) {
            box.querySelector<HTMLElement>('[data-composer-fold-body]')?.animate([{ opacity: 0 }, { opacity: 1 }], timing);
        }
    }, [boxRef, folded]);
}

export function MobilePillComposer(props: MobilePillComposerProps) {
    const { t } = useI18n();
    const {
        message,
        sessionId: currentSessionId,
        newSessionDraftOpen,
        hasContent,
        isVSCode,
        canAbort,
        footerIconButtonClass,
        iconSizeClass,
        sendIconSizeClass,
        stopIconSizeClass,
        topRow,
        attachments,
        bottomRow,
        onExpand,
        onPrimaryAction,
        onQueueMessage,
        onPickLocalFiles,
        onOpenGitHubPicker,
        repositoryProvider,
        showLinearPicker,
        onOpenLinearPicker,
        onOpenAttachSheet,
        onStartDictation,
        onAbort,
    } = props;
    const canPrimaryAction = hasContent && Boolean(currentSessionId || newSessionDraftOpen);
    const showQueueAction = canPrimaryAction && canAbort;
    const dictationEnabled = useConfigStore((state) => state.dictationEnabled);
    const [dictationSupported] = useState(() => !isVSCodeRuntime() && isDictationCaptureSupported());
    const showDictation = dictationEnabled && dictationSupported;
    // The new-session draft screen has nothing to read, so it never folds.
    const showHandle = !newSessionDraftOpen;
    const folded = useMobileComposerFoldStore((state) => state.folded) && showHandle;
    const boxRef = React.useRef<HTMLDivElement | null>(null);
    useFoldTween(boxRef, folded);

    return (
        <div className="flex flex-col">
            <div
                className={cn(
                    'flex min-w-0 flex-col',
                    topRow || bottomRow || showHandle ? 'rounded-[1.5rem]' : 'rounded-full',
                )}
            >
            <div
                data-mobile-composer-pill="true"
                // The morph measures and animates this box (see mobileComposerMorph).
                data-composer-box="true"
                ref={boxRef}
                className={cn(
                    // Lit like the desktop composer box: top edge, hairline,
                    // shadow and, in dark themes, the faint sheen.
                    'oc-surface-floating oc-glass-floating oc-composer-sheen flex min-w-0 flex-col',
                    topRow || bottomRow || showHandle ? 'rounded-[1.5rem]' : 'rounded-full',
                )}
            >
            {showHandle ? <MobileComposerHandle /> : null}
            {/* Folded, the top rows draw only their icons (MobileComposerTopRows)
                and the rest stays mounted but hidden, so a draft, an
                attachment or a running dictation survives the fold. */}
            {topRow}
            <div data-composer-fold-body="true" className={cn('flex min-w-0 flex-col', folded && 'hidden')}>
            {attachments}
            {/* ps-1 puts the attach icon at the same inset the expanded
                footer gives it, and h-12 is the expanded footer's height
                (its buttons sit on the mobile 36px touch floor), so the icons
                do not shift across the swap. */}
            <div className="flex h-12 min-w-0 items-center gap-x-0.5 ps-1 pe-1">
                <ComposerAttachmentControls
                    isVSCode={isVSCode}
                    footerIconButtonClass={footerIconButtonClass}
                    iconSizeClass={iconSizeClass}
                    handlePickLocalFiles={onPickLocalFiles}
                    openGitHubPicker={onOpenGitHubPicker}
                    repositoryProvider={repositoryProvider}
                    showLinearPicker={showLinearPicker}
                    openLinearPicker={onOpenLinearPicker}
                    onOpenMobileSheet={onOpenAttachSheet}
                />
                <button
                    type="button"
                    // The morph moves the editor block to and from this line.
                    data-composer-morph-prompt="true"
                    className="flex h-full min-w-0 flex-1 cursor-text items-center px-1.5 text-start"
                    onClick={onExpand}
                >
                    <span
                        className={cn(
                            'truncate typography-ui-label',
                            message.trim() ? 'text-foreground' : 'text-muted-foreground/40',
                        )}
                    >
                        {message.trim()
                            ? message
                            : currentSessionId || newSessionDraftOpen
                                ? t('chat.chatInput.placeholder.chatCompact')
                                : t('chat.chatInput.placeholder.selectSession')}
                    </span>
                </button>
                {showDictation ? (
                    <button
                        type="button"
                        className={footerIconButtonClass}
                        // Starts recording in place; the composer morphs into the
                        // voice variant once dictation actually goes live.
                        onClick={onStartDictation}
                        title={t('chat.dictation.start')}
                        aria-label={t('chat.dictation.start')}
                    >
                        <Icon name="mic" className={cn(iconSizeClass, 'text-current')} />
                    </button>
                ) : null}
                {/* While a turn runs, a draft can only be queued: the same
                    rotated icon and label the expanded composer uses. */}
                {showQueueAction ? (
                    <button
                        type="button"
                        className={cn(footerIconButtonClass, 'text-primary hover:text-primary')}
                        onClick={onQueueMessage}
                        title={t('chat.chatInput.actions.queueMessageAria')}
                        aria-label={t('chat.chatInput.actions.queueMessageAria')}
                    >
                        <Icon name="send-plane-2" className={cn(sendIconSizeClass, '-rotate-90 rtl:rotate-90')} />
                    </button>
                ) : null}
                {/* Same visibility rule as the full composer's stop control:
                    while a turn is running the stop button takes the mic's
                    end slot and the mic shifts one slot left. Instant swap —
                    no shape animation (WKWebView). */}
                {canAbort ? (
                    <button
                        type="button"
                        className={cn(footerIconButtonClass, 'text-[var(--status-error)] hover:text-[var(--status-error)]')}
                        // The pill shows only while the keyboard is down — the
                        // tap must abort in place, never focus/expand the
                        // composer or raise the keyboard.
                        onMouseDown={(event) => event.preventDefault()}
                        onPointerDownCapture={(event) => {
                            if (event.pointerType === 'touch') {
                                event.preventDefault();
                            }
                        }}
                        onClick={(event) => {
                            event.stopPropagation();
                            onAbort();
                        }}
                        title={t('chat.chatInput.actions.stopGeneratingAria')}
                        aria-label={t('chat.chatInput.actions.stopGeneratingAria')}
                    >
                        <StopIcon className={cn(stopIconSizeClass)} />
                    </button>
                ) : canPrimaryAction ? (
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="text-primary hover:text-primary"
                        onClick={onPrimaryAction}
                        title={t('chat.chatInput.actions.sendMessageAria')}
                        aria-label={t('chat.chatInput.actions.sendMessageAria')}
                    >
                        <Icon name="send-plane-2" className={cn(sendIconSizeClass)} />
                    </Button>
                ) : null}
            </div>
            {bottomRow}
            </div>
            </div>
            </div>
        </div>
    );
}
