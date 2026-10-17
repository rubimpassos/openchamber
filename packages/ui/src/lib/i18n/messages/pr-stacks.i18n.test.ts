import { describe, expect, test } from 'bun:test';
import { LOCALES } from '../runtime';
import { prStacksI18n } from './pr-stacks.i18n';
import { dict as en } from './en';
import { dict as ar } from './ar';
import { dict as de } from './de';
import { dict as es } from './es';
import { dict as fr } from './fr';
import { dict as he } from './he';
import { dict as ja } from './ja';
import { dict as ko } from './ko';
import { dict as nl } from './nl';
import { dict as pl } from './pl';
import { dict as ptBR } from './pt-BR';
import { dict as tr } from './tr';
import { dict as uk } from './uk';
import { dict as zhCN } from './zh-CN';
import { dict as zhTW } from './zh-TW';

const dictionaries = { en, ar, de, es, fr, he, ja, ko, nl, pl, 'pt-BR': ptBR, tr, uk, 'zh-CN': zhCN, 'zh-TW': zhTW };
const placeholders = (text: string) => [...text.matchAll(/\{\w+\}/g)].map((match) => match[0]).sort();

describe('pull stack messages', () => {
  test('includes the complete translated key set in every runtime dictionary', () => {
    for (const locale of LOCALES) {
      const translated: Readonly<Record<string, string>> = prStacksI18n[locale];
      const dictionary: Readonly<Record<string, string>> = dictionaries[locale];
      expect(Object.keys(translated).sort()).toEqual(Object.keys(prStacksI18n.en).sort());
      for (const [key, value] of Object.entries(translated)) {
        expect(value.trim().length).toBeGreaterThan(0);
        expect(dictionary[key]).toBe(value);
      }
      if (locale !== 'en') {
        for (const key of ['prStacks.nativeUnavailable', 'prStacks.merge.enqueued', 'prStacks.merge.pending'] as const) {
          expect(translated[key]).not.toBe(prStacksI18n.en[key]);
        }
      }
    }
  });
  test('preserves interpolation values in all supported languages', () => {
    for (const locale of LOCALES) {
      const translated: Readonly<Record<string, string>> = prStacksI18n[locale];
      for (const [key, value] of Object.entries(prStacksI18n.en)) expect(placeholders(translated[key])).toEqual(placeholders(value));
    }
  });
});
