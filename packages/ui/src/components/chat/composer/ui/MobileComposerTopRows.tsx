import React from 'react';
import { createPortal } from 'react-dom';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
    COMPOSER_STATUS_ROW_ORDER,
    ComposerStatusChipsContext,
    type ComposerStatusChip,
    type ComposerStatusRowId,
} from '../state/composerStatusChips';
import { useMobileComposerFoldStore } from '../state/mobileComposerFold';

/**
 * The composer's top rows on a phone. One row shows as it is; two or more
 * fold into a single line of chips, and a chip opens a sheet holding the rows
 * themselves, actions included.
 *
 * The rows render once, through a portal into a node this component owns,
 * and that node moves between the composer and the sheet. Moving it keeps
 * the rows mounted: re-rendering them per place would unregister their chips
 * on unmount and flip the layout back and forth.
 */
export function MobileComposerTopRows({ rows }: { rows: React.ReactNode }) {
    const { t } = useI18n();
    const [chips, setChips] = React.useState<ReadonlyMap<ComposerStatusRowId, ComposerStatusChip>>(() => new Map());
    const [sheetOpen, setSheetOpen] = React.useState(false);
    const [sheetSlot, setSheetSlot] = React.useState<HTMLDivElement | null>(null);
    const inlineSlotRef = React.useRef<HTMLDivElement | null>(null);
    const [rowsHost] = React.useState(() => document.createElement('div'));

    const register = React.useCallback((id: ComposerStatusRowId, chip: ComposerStatusChip | null) => {
        setChips((current) => {
            const previous = current.get(id);
            if (!chip && !previous) return current;
            if (chip && previous && previous.icon === chip.icon && previous.label === chip.label && previous.spin === chip.spin) {
                return current;
            }
            const next = new Map(current);
            if (chip) next.set(id, chip);
            else next.delete(id);
            return next;
        });
    }, []);

    const orderedChips = COMPOSER_STATUS_ROW_ORDER.flatMap((id) => {
        const chip = chips.get(id);
        return chip ? [{ id, ...chip }] : [];
    });
    const composerFolded = useMobileComposerFoldStore((state) => state.folded);
    const folded = orderedChips.length >= 2 || (composerFolded && orderedChips.length > 0);
    const showInSheet = sheetOpen && folded && sheetSlot !== null;

    React.useLayoutEffect(() => {
        const target = showInSheet ? sheetSlot : inlineSlotRef.current;
        if (target && rowsHost.parentElement !== target) target.appendChild(rowsHost);
        rowsHost.hidden = folded && !showInSheet;
    }, [folded, rowsHost, sheetSlot, showInSheet]);

    React.useLayoutEffect(() => () => rowsHost.remove(), [rowsHost]);

    return (
        <ComposerStatusChipsContext.Provider value={register}>
            {createPortal(rows, rowsHost)}
            {folded && composerFolded ? (
                <button
                    type="button"
                    className="relative z-10 -mt-9 flex h-9 max-w-[40%] items-center gap-2 self-start pl-3.5 pr-2 text-muted-foreground"
                    aria-label={t('chat.composerStatus.openAria')}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => setSheetOpen(true)}
                >
                    {orderedChips.map((chip) => (
                        <Icon
                            key={chip.id}
                            name={chip.icon}
                            className={cn('size-3.5 shrink-0', chip.spin && 'animate-spin')}
                            aria-hidden="true"
                        />
                    ))}
                </button>
            ) : folded ? (
                <div className="scrollbar-none flex items-center gap-1.5 overflow-x-auto border-b border-border/60 px-2.5 py-1.5">
                    {orderedChips.map((chip) => (
                        <Button
                            key={chip.id}
                            variant="outline"
                            size="xs"
                            className="max-w-[14rem] shrink-0 rounded-full"
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => setSheetOpen(true)}
                        >
                            <Icon
                                name={chip.icon}
                                className={cn('size-3.5 shrink-0 text-muted-foreground', chip.spin && 'animate-spin')}
                                aria-hidden="true"
                            />
                            <span className="truncate">{chip.label}</span>
                        </Button>
                    ))}
                </div>
            ) : null}
            <div ref={inlineSlotRef} />
            <MobileOverlayPanel
                open={sheetOpen && folded}
                onClose={() => setSheetOpen(false)}
                title={t('chat.composerStatus.sheetTitle')}
            >
                <div ref={setSheetSlot} />
            </MobileOverlayPanel>
        </ComposerStatusChipsContext.Provider>
    );
}
