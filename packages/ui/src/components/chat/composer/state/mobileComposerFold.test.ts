import { describe, expect, test } from 'bun:test';

import { FOLD_DRAG_THRESHOLD_PX, FOLD_ON_SCROLL_UP_PX, resolveFoldGesture, resolveScrollFold, useMobileComposerFoldStore } from './mobileComposerFold';

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

describe('resolveScrollFold', () => {
    test('upward travel folds once it passes the threshold', () => {
        const first = resolveScrollFold(0, -(FOLD_ON_SCROLL_UP_PX - 10), 500, false);
        expect(first.action).toBeNull();
        expect(resolveScrollFold(first.travelUp, -10, 500, false).action).toBe('fold');
    });

    test('a downward step resets the travel', () => {
        const up = resolveScrollFold(0, -30, 500, false);
        const down = resolveScrollFold(up.travelUp, 5, 500, false);
        expect(down.travelUp).toBe(0);
        expect(resolveScrollFold(down.travelUp, -30, 500, false).action).toBeNull();
    });

    test('reaching the end unfolds; scrolling down elsewhere does not', () => {
        expect(resolveScrollFold(0, 40, 300, true).action).toBeNull();
        expect(resolveScrollFold(0, 40, 4, true).action).toBe('unfold');
    });
});
