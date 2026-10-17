import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Window } from 'happy-dom';
import { I18nProvider } from '@/lib/i18n';
import { DEFAULT_PR_FIX_LOOP_CONFIG, parseFixLoopAuthors } from '@/lib/prFixLoop';
import { PrFixLoopConfigFields } from './PrFixLoopConfigFields';

describe('PR fix-loop configuration fields', () => {
  test('provides one searchable anchor for every config field in Settings', () => {
    // Given
    const window = new Window();
    // When
    window.document.body.innerHTML = renderToStaticMarkup(<I18nProvider>
      <PrFixLoopConfigFields config={DEFAULT_PR_FIX_LOOP_CONFIG} onChange={() => undefined} settings />
    </I18nProvider>);
    // Then
    for (const field of Object.keys(DEFAULT_PR_FIX_LOOP_CONFIG)) {
      expect(window.document.querySelector(`[data-settings-item="integrations.pr-fix-loop.${field}"]`)).not.toBeNull();
    }
    window.close();
  });

  test('requires nonempty mention text when mention-only filtering is chosen', () => {
    // Given
    const window = new Window();
    // When
    window.document.body.innerHTML = renderToStaticMarkup(<I18nProvider>
      <PrFixLoopConfigFields config={{ ...DEFAULT_PR_FIX_LOOP_CONFIG, mentionOnly: true }} onChange={() => undefined} />
    </I18nProvider>);
    // Then
    const input = window.document.querySelector('input[name="mentionText"]');
    expect(input?.hasAttribute('required')).toBe(true);
    expect(input?.getAttribute('pattern')).toBe('.*\\S.*');
    window.close();
  });

  test('parses pasted author lists into separate logins', () => {
    // Given
    const value = '@alice, bob\n@carol alice';
    // When
    const authors = parseFixLoopAuthors(value);
    // Then
    expect(authors).toEqual(['alice', 'bob', 'carol']);
  });

  test('locks only the execution mode when editing an existing loop', () => {
    // Given
    const window = new Window();
    // When
    window.document.body.innerHTML = renderToStaticMarkup(<I18nProvider>
      <PrFixLoopConfigFields config={DEFAULT_PR_FIX_LOOP_CONFIG} onChange={() => undefined} executionModeLocked />
    </I18nProvider>);
    // Then
    expect(window.document.querySelector('[aria-label="Push changes"]')?.hasAttribute('disabled')).toBe(true);
    expect(window.document.querySelector('input[name="allowAuthors"]')?.hasAttribute('disabled')).toBe(false);
    window.close();
  });
});
