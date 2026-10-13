import React from 'react';

import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { resolveFoldGesture, useMobileComposerFoldStore } from '../state/mobileComposerFold';

const DRAG_START_PX = 6;

/**
 * The grabber on top of the phone composer. Dragging it down folds the
 * composer to this strip, dragging up or tapping brings it back. A tap is the
 * single-pointer alternative Material asks for, and Enter/Space do the same.
 */
export function MobileComposerHandle() {
    const { t } = useI18n();
    const folded = useMobileComposerFoldStore((state) => state.folded);
    const setFolded = useMobileComposerFoldStore((state) => state.setFolded);
    const dragRef = React.useRef<{ startY: number; moved: boolean } | null>(null);

    const finish = (clientY: number) => {
        const drag = dragRef.current;
        dragRef.current = null;
        if (!drag) return;
        const gesture = resolveFoldGesture(clientY - drag.startY, drag.moved);
        if (gesture === 'toggle') setFolded(!folded);
        else if (gesture === 'fold') setFolded(true);
        else if (gesture === 'unfold') setFolded(false);
    };

    return (
        <div
            role="button"
            tabIndex={0}
            aria-label={folded ? t('chat.composerHandle.unfoldAria') : t('chat.composerHandle.foldAria')}
            aria-expanded={!folded}
            className={cn(
                'relative flex w-full shrink-0 cursor-grab touch-none select-none items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                folded ? 'h-9' : 'h-3.5',
            )}
            // Keep the tap from moving focus: on a phone that would dismiss the keyboard.
            onMouseDown={(event) => event.preventDefault()}
            onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                dragRef.current = { startY: event.clientY, moved: false };
            }}
            onPointerMove={(event) => {
                const drag = dragRef.current;
                if (drag && Math.abs(event.clientY - drag.startY) > DRAG_START_PX) drag.moved = true;
            }}
            onPointerUp={(event) => finish(event.clientY)}
            onPointerCancel={() => { dragRef.current = null; }}
            onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                setFolded(!folded);
            }}
        >
            <span aria-hidden="true" className={cn('h-1 w-8 rounded-full bg-border', !folded && 'mt-1.5')} />
        </div>
    );
}
