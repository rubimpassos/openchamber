import { describe, expect, test } from 'bun:test';

import { extensionPlansI18n } from './extension-plans.i18n';

const locales = ['en', 'uk', 'de', 'fr', 'es', 'pt-BR', 'nl', 'pl', 'tr', 'ja', 'ko', 'zh-CN', 'zh-TW', 'ar', 'he'] as const;

const placeholders = (value: string): string[] => [...value.matchAll(/\{[^{}]+\}/g)].map((match) => match[0]).sort();

describe('extension plan translations', () => {
  test('every locale has every key with the same placeholders', () => {
    const english = Object.entries(extensionPlansI18n.en);
    for (const locale of locales) {
      const dictionary = new Map<string, string>(Object.entries(extensionPlansI18n[locale]));
      expect([...dictionary.keys()].sort()).toEqual(english.map(([key]) => key).sort());
      for (const [key, englishText] of english) {
        expect(dictionary.get(key)?.trim()).toBeTruthy();
        expect(placeholders(dictionary.get(key) ?? '')).toEqual(placeholders(englishText));
      }
    }
  });
});
