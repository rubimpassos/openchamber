import React from 'react';

import type { Part } from '@/lib/opencode/model';
import { Icon } from '@/components/icon/Icon';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { getPromptPreviewText } from '../lib/messagePreview';

interface PinnedPromptStripProps {
    scrollRef: React.RefObject<HTMLElement | null>;
    turnId: string;
    promptParts: Part[];
}

/**
 * The phone's sticky user header: one line naming the prompt of the turn on
 * screen, shown once that prompt has scrolled above the viewport. A full
 * sticky bubble took a quarter of a phone screen.
 */
export const PinnedPromptStrip: React.FC<PinnedPromptStripProps> = ({ scrollRef, turnId, promptParts }) => {
    const { t } = useI18n();
    const [promptAbove, setPromptAbove] = React.useState(false);
    const [sheetOpen, setSheetOpen] = React.useState(false);

    // An observer instead of a scroll handler: it reports only when the
    // prompt crosses the top edge, so scrolling reads no layout.
    React.useEffect(() => {
        const root = scrollRef.current;
        const prompt = root?.querySelector(`[data-turn-id="${CSS.escape(turnId)}"]`)?.firstElementChild;
        if (!root || !prompt) {
            setPromptAbove(false);
            return;
        }
        const observer = new IntersectionObserver(([entry]) => {
            const rootTop = entry.rootBounds?.top;
            setPromptAbove(!entry.isIntersecting && rootTop !== undefined && entry.boundingClientRect.top < rootTop);
        }, { root });
        observer.observe(prompt);
        return () => observer.disconnect();
    }, [scrollRef, turnId]);

    const text = React.useMemo(() => getPromptPreviewText(promptParts, t), [promptParts, t]);

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
                    className="flex min-h-9 min-w-0 flex-1 items-center gap-2 text-start focus-visible:outline-none"
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
            >
                <div dir="auto" className="whitespace-pre-wrap break-words px-3 pb-3 typography-markdown text-foreground">{text}</div>
            </MobileOverlayPanel>
        </>
    );
};
