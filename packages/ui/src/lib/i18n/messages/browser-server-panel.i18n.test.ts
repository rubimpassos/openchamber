import { describe, expect, test } from 'bun:test';

import { browserServerPanelI18n } from './browser-server-panel.i18n';

const locales = ['en', 'de', 'fr', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr'] as const;

describe('server browser panel translations', () => {
  test('provides every key in every supported locale, translated', () => {
    const english = browserServerPanelI18n.en;
    const keys = Object.keys(english) as Array<keyof typeof english>;
    expect(keys.length).toBeGreaterThan(0);
    for (const locale of locales) {
      for (const key of keys) {
        expect(browserServerPanelI18n[locale][key]).toBeTruthy();
      }
    }
  });

  test('keeps the same placeholders in every locale', () => {
    const english = browserServerPanelI18n.en;
    const placeholder = /\{[a-zA-Z]+\}/g;
    for (const [key, text] of Object.entries(english)) {
      const expected = [...text.matchAll(placeholder)].map((match) => match[0]).sort();
      if (expected.length === 0) continue;
      for (const locale of locales) {
        const value = browserServerPanelI18n[locale][key as keyof typeof english];
        const actual = [...value.matchAll(placeholder)].map((match) => match[0]).sort();
        expect(actual).toEqual(expected);
      }
    }
  });
});
