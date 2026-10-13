import React from 'react';

import type { Part } from '@/lib/opencode/model';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { MessageFilesDisplay } from '../FileAttachment';
import UserTextPart from '../message/parts/UserTextPart';
import { isEmptyTextPart } from '../message/partUtils';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { getPromptPreviewText } from '../lib/messagePreview';

interface PinnedPromptStripProps {
    scrollRef: React.RefObject<HTMLElement | null>;
    turnId: string;
    promptParts: Part[];
    /** Scrolls the timeline to the prompt itself. */
    onGoToPrompt: (turnId: string) => void;
}

const noop = () => {};

/**
 * The phone's sticky user header: one line naming the prompt of the turn on
 * screen, shown once that prompt has scrolled above the viewport. A full
 * sticky bubble took a quarter of a phone screen.
 */
export const PinnedPromptStrip: React.FC<PinnedPromptStripProps> = ({ scrollRef, turnId, promptParts, onGoToPrompt }) => {
    const { t } = useI18n();
    const [promptAbove, setPromptAbove] = React.useState(false);
    const [sheetOpen, setSheetOpen] = React.useState(false);

    // The list is virtualized and recycles row nodes, so the prompt node is
    // looked up again on each check. Checks run at most once per frame, and
    // read one rect.
    React.useEffect(() => {
        const root = scrollRef.current;
        if (!root) return;
        let frame = 0;
        const check = () => {
            frame = 0;
            const prompt = root.querySelector(`[data-turn-id="${CSS.escape(turnId)}"]`)?.firstElementChild;
            setPromptAbove(prompt ? prompt.getBoundingClientRect().bottom < root.getBoundingClientRect().top : false);
        };
        const schedule = () => { if (!frame) frame = requestAnimationFrame(check); };
        check();
        root.addEventListener('scroll', schedule, { passive: true });
        return () => {
            root.removeEventListener('scroll', schedule);
            if (frame) cancelAnimationFrame(frame);
        };
    }, [scrollRef, turnId]);

    const text = React.useMemo(() => getPromptPreviewText(promptParts, t), [promptParts, t]);
    const textParts = React.useMemo(() => promptParts.filter((part) => part.type === 'text' && !isEmptyTextPart(part)), [promptParts]);
    const attachmentFilenames = React.useMemo(() => promptParts.flatMap((part) => (
        part.type === 'file' && part.filename ? [part.filename] : []
    )), [promptParts]);

    if (!text) return null;

    return (
        <>
            <div
                className={cn(
                    'absolute inset-x-2.5 top-1.5 z-20 flex items-center gap-1 rounded-xl border border-border/60 bg-background/90 px-3 shadow-sm backdrop-blur transition-[opacity,transform] duration-150',
                    promptAbove ? 'opacity-100' : 'pointer-events-none -translate-y-2 opacity-0',
                )}
                aria-hidden={!promptAbove}
            >
                <button
                    type="button"
                    className="flex min-h-9 min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none"
                    aria-label={t('chat.pinnedPrompt.openAria')}
                    onClick={() => setSheetOpen(true)}
                    tabIndex={promptAbove ? 0 : -1}
                >
                    <Icon name="pushpin-2" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span dir="auto" className="min-w-0 flex-1 truncate typography-meta text-foreground">{text.replace(/\n/g, ' ')}</span>
                </button>
            </div>
            <MobileOverlayPanel
                open={sheetOpen}
                onClose={() => setSheetOpen(false)}
                title={t('chat.pinnedPrompt.sheetTitle')}
                footer={(
                    <Button
                        variant="secondary"
                        className="w-full normal-case"
                        onClick={() => {
                            setSheetOpen(false);
                            onGoToPrompt(turnId);
                        }}
                    >
                        <Icon name="arrow-up" className="size-4" aria-hidden="true" />
                        {t('chat.pinnedPrompt.goToMessage')}
                    </Button>
                )}
            >
                {/* The same parts the bubble draws: attachments first, then the
                    text, always expanded. */}
                <div className="px-3 pb-3 leading-relaxed text-foreground/90">
                    <MessageFilesDisplay files={promptParts} compact className={textParts.length > 0 ? 'mb-2' : 'mt-0'} />
                    {textParts.map((part, index) => (
                        <UserTextPart
                            key={`pinned-${index}`}
                            part={part}
                            messageId={turnId}
                            isMobile
                            messageExpanded
                            onExpandMessage={noop}
                            partIndex={index}
                            onTruncationChange={noop}
                            attachmentFilenames={attachmentFilenames}
                        />
                    ))}
                </div>
            </MobileOverlayPanel>
        </>
    );
};
