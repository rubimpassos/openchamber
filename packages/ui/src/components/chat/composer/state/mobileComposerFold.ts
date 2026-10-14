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

/** Momentum after the finger lifts still counts as the reader's scroll. */
const GESTURE_TAIL_MS = 900;
/** After the scroll stops, a half-hidden composer settles to the nearer end. */
const SETTLE_DELAY_MS = 140;
const SETTLE_MS = 180;
/** The part of the composer that stays on screen when scrolled away: its handle row. */
const VISIBLE_WHEN_HIDDEN_PX = 22;

/**
 * How far the composer sits below its place after a scroll step. Scrolling
 * back through the reply pushes it down by exactly the distance scrolled, and
 * scrolling forward pulls it back the same way, so it moves with the text.
 */
export function resolveScrollOffset(offset: number, delta: number, max: number): number {
    return Math.min(max, Math.max(0, offset - delta));
}

/** Where a half-hidden composer settles once the scroll stops. */
export function resolveSettledOffset(offset: number, max: number, distanceFromEnd: number): number {
    if (distanceFromEnd <= 8) return 0;
    return offset > max / 2 ? max : 0;
}

let revealHidden: (() => boolean) | null = null;

/** Brings a scrolled-away composer back. Returns false when it was not away. */
export function revealScrollHiddenComposer(): boolean {
    return revealHidden ? revealHidden() : false;
}

/**
 * Phones: the composer is tied to the reader's scroll. Reading back through
 * the transcript slides it down with the text until only its handle shows;
 * reading forward slides it back. It moves through the individual `translate`
 * property on the pill box, so the transcript inset and the keyboard
 * choreography (which own `transform` and the box height) are untouched.
 * Only scrolls the reader drives count (a touch, its momentum, a wheel), and
 * nothing moves while the keyboard is open.
 */
export function useFoldComposerOnScroll(scrollNode: HTMLElement | null, enabled: boolean): void {
    React.useEffect(() => {
        if (!enabled || !scrollNode) return;
        const root = scrollNode.ownerDocument.documentElement;
        let lastTop = scrollNode.scrollTop;
        let offset = 0;
        let touching = false;
        let gestureUntil = 0;
        let settleTimer: ReturnType<typeof setTimeout> | null = null;
        // The pill's shadow wrapper moves, so the shadow travels with the glass.
        const box = () => scrollNode.ownerDocument.querySelector<HTMLElement>('[data-mobile-composer-pill="true"]')?.parentElement ?? null;
        const apply = (next: number, animate: boolean) => {
            offset = next;
            const el = box();
            if (!el) return;
            el.style.transition = animate ? `translate ${SETTLE_MS}ms ease-out` : 'none';
            el.style.translate = offset > 0 ? `0 ${offset}px` : '';
        };
        const maxOffset = () => Math.max(0, (box()?.offsetHeight ?? 0) - VISIBLE_WHEN_HIDDEN_PX);
        const settle = () => {
            settleTimer = null;
            if (touching) return;
            const target = resolveSettledOffset(offset, maxOffset(), scrollNode.scrollHeight - scrollNode.clientHeight - scrollNode.scrollTop);
            if (target !== offset) apply(target, true);
        };
        const readerDriven = () => touching || performance.now() < gestureUntil;
        const onTouchStart = () => { touching = true; };
        const onTouchEnd = () => {
            touching = false;
            gestureUntil = performance.now() + GESTURE_TAIL_MS;
            if (!settleTimer) settleTimer = setTimeout(settle, SETTLE_DELAY_MS);
        };
        const onWheel = () => { gestureUntil = performance.now() + GESTURE_TAIL_MS; };
        const onScroll = () => {
            const top = scrollNode.scrollTop;
            const delta = top - lastTop;
            lastTop = top;
            if (root.classList.contains('oc-composer-expanded')) {
                if (offset) apply(0, false);
                return;
            }
            if (!readerDriven()) return;
            const next = resolveScrollOffset(offset, delta, maxOffset());
            if (next !== offset) apply(next, false);
            if (settleTimer) clearTimeout(settleTimer);
            settleTimer = setTimeout(settle, SETTLE_DELAY_MS);
        };
        revealHidden = () => {
            if (offset === 0) return false;
            apply(0, true);
            return true;
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
            if (settleTimer) clearTimeout(settleTimer);
            revealHidden = null;
            apply(0, false);
        };
    }, [enabled, scrollNode]);
}
