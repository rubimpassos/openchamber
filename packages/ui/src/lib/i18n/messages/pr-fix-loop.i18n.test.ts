import { describe, expect, test } from 'bun:test';
import { LOCALES } from '../runtime';
import { prFixLoopI18n } from './pr-fix-loop.i18n';

describe('PR fix-loop translations', () => {
  test('provides translated keys in every shipped locale', () => {
    // Given
    const english = prFixLoopI18n.en;
    // When
    for (const locale of LOCALES) {
      const messages: { [Key in keyof typeof english]: string } = prFixLoopI18n[locale];
      const values = new Map(Object.entries(messages));
      // Then
      expect(Object.keys(messages).sort()).toEqual(Object.keys(english).sort());
      for (const [key, source] of Object.entries(english)) {
        const translated = values.get(key);
        expect(translated?.trim()).toBeTruthy();
        if (locale !== 'en') expect(translated).not.toBe(source);
      }
    }
  });

  test('preserves dynamic value placeholders in every translation', () => {
    // Given
    const placeholders = (value: string) => [...value.matchAll(/\{[a-zA-Z]+\}/g)].map(([match]) => match).sort();
    // When
    for (const locale of LOCALES) {
      const values = new Map(Object.entries(prFixLoopI18n[locale]));
      // Then
      for (const [key, value] of Object.entries(prFixLoopI18n.en)) {
        expect(placeholders(values.get(key) ?? '')).toEqual(placeholders(value));
      }
    }
  });
});
