import { describe, expect, test } from 'bun:test';

import { FOLD_DRAG_THRESHOLD_PX, resolveFoldGesture, useMobileComposerFoldStore } from './mobileComposerFold';

describe('resolveFoldGesture', () => {
    test('a press without travel toggles', () => {
        expect(resolveFoldGesture(0, false)).toBe('toggle');
    });

    test('a drag past the threshold folds down and unfolds up', () => {
        expect(resolveFoldGesture(FOLD_DRAG_THRESHOLD_PX, true)).toBe('fold');
        expect(resolveFoldGesture(-FOLD_DRAG_THRESHOLD_PX, true)).toBe('unfold');
    });

    test('a short drag does nothing', () => {
        expect(resolveFoldGesture(FOLD_DRAG_THRESHOLD_PX - 1, true)).toBeNull();
        expect(resolveFoldGesture(1 - FOLD_DRAG_THRESHOLD_PX, true)).toBeNull();
    });
});

describe('useMobileComposerFoldStore', () => {
    test('setting the same value keeps the state object', () => {
        const store = useMobileComposerFoldStore;
        store.getState().setFolded(false);
        const before = store.getState();
        store.getState().setFolded(false);
        expect(store.getState()).toBe(before);
        store.getState().setFolded(true);
        expect(store.getState().folded).toBe(true);
        store.getState().setFolded(false);
    });
});
