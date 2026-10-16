import { describe, expect, test } from 'bun:test';

import { notificationCenterI18n } from './notification-center.i18n';

const locales = ['en', 'de', 'fr', 'nl', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr', 'ar', 'he'] as const;

/** Words these languages spell the same as English. */
const SAME_AS_ENGLISH = new Set([
  'nl notificationCenter.kind.browserHelp',
  'de notificationCenter.kind.browserHelp',
  'de notificationCenter.kind.plugin',
  'pt-BR notificationCenter.kind.plugin',
  'es notificationCenter.kind.error',
  'fr notificationCenter.title',
  'fr notificationCenter.kind.question',
]);

describe('notification center translations', () => {
  test('every locale has every key, translated, with the same placeholders', () => {
    const english = Object.entries(notificationCenterI18n.en);
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const locale of locales) {
      const dictionary = new Map<string, string>(Object.entries(notificationCenterI18n[locale]));
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
