import React from 'react';
import { create } from 'zustand';

/**
 * Whether the phone composer is folded down to its handle so the reader gets
 * the screen. App-wide on purpose: it survives the pill/composer swap and a
 * session switch, and the next tap on the composer unfolds it.
 */
type MobileComposerFoldState = {
    folded: boolean;
    setFolded: (folded: boolean) => void;
};

export const useMobileComposerFoldStore = create<MobileComposerFoldState>()((set) => ({
    folded: false,
    setFolded: (folded) => set((state) => (state.folded === folded ? state : { folded })),
}));

/** A drag this far down folds, this far up unfolds; anything shorter is a tap. */
export const FOLD_DRAG_THRESHOLD_PX = 24;

export type FoldGesture = 'fold' | 'unfold' | 'toggle' | null;

/** What a finished pointer gesture on the handle means, from its vertical travel. */
export function resolveFoldGesture(deltaY: number, moved: boolean): FoldGesture {
    if (!moved) return 'toggle';
    if (deltaY >= FOLD_DRAG_THRESHOLD_PX) return 'fold';
    if (deltaY <= -FOLD_DRAG_THRESHOLD_PX) return 'unfold';
    return null;
}

/** Upward travel of a reader's scroll before the composer folds away. */
export const FOLD_ON_SCROLL_UP_PX = 48;
/** Within this distance of the end, reaching it again brings the composer back. */
const UNFOLD_AT_END_PX = 8;
/** Momentum after the finger lifts still counts as the reader's scroll. */
const GESTURE_TAIL_MS = 900;

export type ScrollFoldStep = { travelUp: number; action: 'fold' | 'unfold' | null };

/**
 * What one scroll event means for the fold. `travelUp` accumulates upward
 * movement and resets on any downward step, so a slow drift up does not
 * fold, only a deliberate scroll back through the reply.
 */
export function resolveScrollFold(previousTravelUp: number, delta: number, distanceFromEnd: number, folded: boolean): ScrollFoldStep {
    if (delta > 0) {
        return { travelUp: 0, action: folded && distanceFromEnd <= UNFOLD_AT_END_PX ? 'unfold' : null };
    }
    const travelUp = previousTravelUp - delta;
    if (!folded && travelUp >= FOLD_ON_SCROLL_UP_PX) return { travelUp: 0, action: 'fold' };
    return { travelUp, action: null };
}

/**
 * Phones: scrolling back through the transcript folds the composer, scrolling
 * down to the end unfolds it. Only scrolls the reader drives count (a touch,
 * its momentum, or a wheel), so following a live reply, loading history or
 * the keyboard moving the view never fold it. The open keyboard always wins.
 */
export function useFoldComposerOnScroll(scrollNode: HTMLElement | null, enabled: boolean): void {
    React.useEffect(() => {
        if (!enabled || !scrollNode) return;
        let lastTop = scrollNode.scrollTop;
        let travelUp = 0;
        let touching = false;
        let gestureUntil = 0;
        const readerDriven = () => touching || performance.now() < gestureUntil;
        const onTouchStart = () => { touching = true; };
        const onTouchEnd = () => { touching = false; gestureUntil = performance.now() + GESTURE_TAIL_MS; };
        const onWheel = () => { gestureUntil = performance.now() + GESTURE_TAIL_MS; };
        const onScroll = () => {
            const top = scrollNode.scrollTop;
            const delta = top - lastTop;
            lastTop = top;
            if (document.documentElement.classList.contains('oc-composer-expanded')) {
                travelUp = 0;
                return;
            }
            const store = useMobileComposerFoldStore.getState();
            const distanceFromEnd = scrollNode.scrollHeight - scrollNode.clientHeight - top;
            // Arriving at the end unfolds in the same frame, whoever drove the
            // scroll: a fling's momentum can outlast the gesture window, and
            // waiting for it left the composer late by a varying amount.
            if (!readerDriven()) {
                travelUp = 0;
                if (store.folded && delta > 0 && distanceFromEnd <= UNFOLD_AT_END_PX) store.setFolded(false);
                return;
            }
            const step = resolveScrollFold(travelUp, delta, distanceFromEnd, store.folded);
            travelUp = step.travelUp;
            if (step.action) store.setFolded(step.action === 'fold');
        };
        scrollNode.addEventListener('touchstart', onTouchStart, { passive: true });
        scrollNode.addEventListener('touchend', onTouchEnd, { passive: true });
        scrollNode.addEventListener('touchcancel', onTouchEnd, { passive: true });
        scrollNode.addEventListener('wheel', onWheel, { passive: true });
        scrollNode.addEventListener('scroll', onScroll, { passive: true });
        return () => {
            scrollNode.removeEventListener('touchstart', onTouchStart);
            scrollNode.removeEventListener('touchend', onTouchEnd);
            scrollNode.removeEventListener('touchcancel', onTouchEnd);
            scrollNode.removeEventListener('wheel', onWheel);
            scrollNode.removeEventListener('scroll', onScroll);
        };
    }, [enabled, scrollNode]);
}
