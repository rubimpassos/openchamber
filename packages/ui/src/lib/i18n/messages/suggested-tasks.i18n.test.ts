import { describe, expect, test } from 'bun:test';

import { suggestedTasksI18n } from './suggested-tasks.i18n';

const locales = ['en', 'de', 'fr', 'nl', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr', 'ar', 'he'] as const;

describe('suggested tasks translations', () => {
  test('every locale has every key, translated, with the same placeholders', () => {
    const english = Object.entries(suggestedTasksI18n.en);
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const locale of locales) {
      const dictionary = new Map<string, string>(Object.entries(suggestedTasksI18n[locale]));
      expect([...dictionary.keys()].sort()).toEqual(english.map(([key]) => key).sort());
      for (const [key, englishText] of english) {
        const text = dictionary.get(key) ?? '';
        expect(text.trim()).toBeTruthy();
        expect(`${locale} ${key}: ${placeholders(text).join(',')}`).toBe(`${locale} ${key}: ${placeholders(englishText).join(',')}`);
        if (locale !== 'en') {
          expect(`${locale} ${key}: ${text}`).not.toBe(`${locale} ${key}: ${englishText}`);
        }
      }
    }
  });
});
