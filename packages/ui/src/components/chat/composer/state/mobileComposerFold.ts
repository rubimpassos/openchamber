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
