import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { I18nProvider } from '@/lib/i18n';
import { useComposerStatusChip, type ComposerStatusRowId } from '../state/composerStatusChips';
import { useMobileComposerFoldStore } from '../state/mobileComposerFold';
import { MobileComposerTopRows } from './MobileComposerTopRows';

function Row({ id, label }: { id: ComposerStatusRowId; label: string }) {
    useComposerStatusChip(id, { icon: 'target', label });
    return <div data-row={id}>{`${label} row`}</div>;
}

describe('MobileComposerTopRows', () => {
    let windowInstance: Window;
    let host: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        windowInstance = new Window();
        Object.assign(globalThis, {
            window: windowInstance,
            document: windowInstance.document,
            HTMLElement: windowInstance.HTMLElement,
            Element: windowInstance.Element,
            Node: windowInstance.Node,
            IS_REACT_ACT_ENVIRONMENT: true,
        });
        useMobileComposerFoldStore.getState().setFolded(false);
        host = document.createElement('div');
        document.body.append(host);
        root = createRoot(host);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        await windowInstance.happyDOM.close();
        useMobileComposerFoldStore.getState().setFolded(false);
    });

    const render = (rows: React.ReactNode) => act(async () => {
        root.render(<I18nProvider><MobileComposerTopRows rows={rows} /></I18nProvider>);
    });
    const chipLabels = () => [...host.querySelectorAll('button')].map((button) => button.textContent);
    const rowVisible = (id: string) => {
        const row = host.querySelector(`[data-row="${id}"]`);
        return Boolean(row) && !row?.closest('[hidden]');
    };

    test('one row shows as it is, with no chips', async () => {
        await render(<Row id="goal" label="Ship it" />);
        expect(rowVisible('goal')).toBe(true);
        expect(chipLabels()).toEqual([]);
    });

    test('two rows fold into chips in stacking order and stay mounted', async () => {
        await render(<><Row id="queue" label="Queued 1" /><Row id="worktree" label="Setting up" /></>);
        expect(chipLabels()).toEqual(['Setting up', 'Queued 1']);
        expect(rowVisible('queue')).toBe(false);
        expect(host.querySelector('[data-row="queue"]')).not.toBeNull();
    });

    test('a row going away unfolds the remaining one', async () => {
        await render(<><Row id="goal" label="Ship it" /><Row id="queue" label="Queued 1" /></>);
        await render(<Row id="goal" label="Ship it" />);
        expect(chipLabels()).toEqual([]);
        expect(rowVisible('goal')).toBe(true);
    });

    test('a folded composer reduces even one row to its icon', async () => {
        await act(async () => useMobileComposerFoldStore.getState().setFolded(true));
        await render(<Row id="goal" label="Ship it" />);
        expect(rowVisible('goal')).toBe(false);
        expect(host.querySelectorAll('button')).toHaveLength(1);
        expect(chipLabels()).toEqual(['']);
    });
});
