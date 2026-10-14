import { describe, expect, test } from 'bun:test';

import { FOLD_DRAG_THRESHOLD_PX, resolveFoldGesture, resolveScrollOffset, resolveSettledOffset, useMobileComposerFoldStore } from './mobileComposerFold';

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

describe('resolveScrollOffset', () => {
    test('scrolling back pushes the composer down by the distance scrolled', () => {
        expect(resolveScrollOffset(0, -30, 120)).toBe(30);
        expect(resolveScrollOffset(30, -200, 120)).toBe(120);
    });

    test('scrolling forward pulls it back, never past its place', () => {
        expect(resolveScrollOffset(120, 50, 120)).toBe(70);
        expect(resolveScrollOffset(20, 50, 120)).toBe(0);
    });
});

describe('resolveSettledOffset', () => {
    test('settles to the nearer end, and back in place at the end of the transcript', () => {
        expect(resolveSettledOffset(70, 120, 400)).toBe(120);
        expect(resolveSettledOffset(50, 120, 400)).toBe(0);
        expect(resolveSettledOffset(120, 120, 2)).toBe(0);
    });
});
