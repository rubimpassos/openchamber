import { describe, expect, test } from 'bun:test';
import { Marked } from 'marked';
import { boundedMarkdownTokenizer } from './markdownLexicalBounds';

describe('bounded native Markdown tokenizers', () => {
  const cases = {
    'multiline setext heading': 'First line\nsecond line\n---\n\nAfter',
    'space-only blank before setext': 'First\n  \nSecond\n===\n\nAfter',
    'tab-only line before setext': 'First\n\t\nSecond\n===',
    'indented setext': 'Title\n   ===   \n\nAfter',
    'setext after interrupted text': 'text\n1. \n\nTitle\n---',
    'table with leading spaces': '  | a | b |\n   |:-|--:|\n| 1 | 2 |\n\nAfter',
    'table without outer pipes': 'a | b\n:- | -:\n1 | 2',
    'single-column table': 'name\n:-:\nvalue',
    'invalid table': 'Intro\n| a |\n|---|---|\nrow',
    'nested block structures': '> Quoted\n>\n> **bold**\n\n- item\n\n  continuation\n\n---\n\n***\n\n___',
    'raw HTML across blank lines': '<div>\n\nBody\n\n</div>\n\nAfter',
    'raw script across blank lines': '<script>\n\nbody()\n\n</script>\n\nAfter',
    'references defined later': 'See [a][ref], [ref] and ![ref].\n\n[ref]: https://example.test "title"',
    'unresolved references': '[**bold**][missing] ![image][missing] [short] [collapsed][]',
    'unfinished labels': '[before _emphasis_ and **strong** ![unfinished ~strike~',
    'nested labels': '[one [two] _three_] ![image [nested]]',
    'escaped labels': '[one \\] _two_ \\[ **three**] [trailing\\',
    'code within labels': '[`literal ] [ text` **bold**] [<span>html</span>]',
    'links within literal brackets': '[https://example.test] [user@example.test] [www.example.test]',
    'bare URL schemes': 'http://example.test HTTPS://example.test ftp://example.test www.example.test',
    'email local-part characters': 'a.b+c-d_e@example.test 1@example.test .a@example.test +a@example.test',
    'email beside emphasis': '_a@example.test_ **a+b@example.test** [a@example.test](https://example.test)',
  } satisfies Record<string, string>;

  for (const [name, source] of Object.entries(cases)) {
    test(`preserves native Markdown semantics for ${name}`, () => {
      // Given the same GFM source and the unmodified parser as its reference.
      const original = new Marked();
      const bounded = new Marked({ tokenizer: boundedMarkdownTokenizer });
      const expected = original.parse(source, { async: false });

      // When impossible-token guards are enabled.
      const actual = bounded.parse(source, { async: false });

      // Then every rendered construct has its original meaning.
      expect(actual).toBe(expected);
    });
  }

  test('keeps horizontal-rule raw text and offsets inside and after lists', () => {
    // Given spaced/tabbed rules followed by several blank lines.
    const source = '- first\n- second\n\n-\t-\t-\t\n\n\nAfter\n\n   ***  \n\n\nEnd';
    const expected = new Marked().lexer(source);

    // When the line-bounded rule also runs inside the native list tokenizer.
    const actual = new Marked({ tokenizer: boundedMarkdownTokenizer }).lexer(source);

    // Then segmentation retains every raw character and token boundary.
    expect(actual).toEqual(expected);
  });
});
