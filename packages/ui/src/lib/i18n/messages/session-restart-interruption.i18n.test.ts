import { describe, expect, test } from 'bun:test';

import { sessionRestartInterruptionI18n } from './session-restart-interruption.i18n';

const locales = ['en', 'de', 'fr', 'nl', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr', 'ar', 'he'] as const;

/** Words these languages spell the same as English. */
const SAME_AS_ENGLISH = new Set<string>([]);

describe('session restart interruption translations', () => {
  test('every locale has every key, translated, with the same placeholders', () => {
    const english = Object.entries(sessionRestartInterruptionI18n.en);
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const locale of locales) {
      const dictionary = new Map<string, string>(Object.entries(sessionRestartInterruptionI18n[locale]));
      expect([...dictionary.keys()].sort()).toEqual(english.map(([key]) => key).sort());
      for (const [key, englishText] of english) {
        const text = dictionary.get(key) ?? '';
        expect(text.trim()).toBeTruthy();
        expect(`${locale} ${key}: ${placeholders(text).join(',')}`).toBe(`${locale} ${key}: ${placeholders(englishText).join(',')}`);
        if (locale !== 'en' && !SAME_AS_ENGLISH.has(`${locale} ${key}`)) {
          expect(`${locale} ${key}: ${text}`).not.toBe(`${locale} ${key}: ${englishText}`);
        }
      }
    }
  });
});
