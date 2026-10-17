import type { MarkedExtension } from 'marked';
import markedLinkifyIt from 'marked-linkify-it';

// Characters read by extension start searches. Native tokenizer guards below
// do not change these counters or the existing search budgets.
const scanStats = { linkify: 0, blockStart: 0 };

export const resetScanStatsForTests = (): void => {
  scanStats.linkify = 0;
  scanStats.blockStart = 0;
};
export const __scanStatsForTests = () => ({ ...scanStats });

// marked's paragraph stops before a space-only blank line, including the two
// spaces user messages put on each empty line. A tab-only line may continue it.
const paragraphWindow = (src: string): string => {
  const end = /\n *\n/.exec(src);
  return end ? src.slice(0, end.index + 1) : src;
};

export const untilParagraphEnd = (src: string): string => {
  const window = paragraphWindow(src);
  scanStats.blockStart += window.length;
  return window;
};

const blockMarker = (src: string): string => src.slice(0, 4).trimStart().charAt(0);

// The list tokenizer also calls rules.block.hr directly for every remaining
// list tail. Keep that rule line-bounded as well as the public hr tokenizer.
// A matching rule consumes all immediately following newlines, just as marked
// does, so block offsets and streaming identities retain the original raw text.
class FirstLineHorizontalRule extends RegExp {
  override exec(src: string): RegExpExecArray | null {
    const lineEnd = src.indexOf('\n');
    const match = super.exec(lineEnd === -1 ? src : src.slice(0, lineEnd + 1));
    if (match && lineEnd !== -1) {
      let end = lineEnd + 1;
      while (src.charAt(end) === '\n') end += 1;
      match[0] = src.slice(0, end);
      match.input = src;
    }
    return match;
  }
}

// JavaScriptCore scans the remaining source even for some anchored native
// marked regexes that cannot match its prefix. Repeating that per paragraph or
// inline token makes rendering quadratic. Reject impossible candidates first;
// false delegates possible ones to marked with the entire, unchanged source.
export const boundedMarkdownTokenizer: NonNullable<MarkedExtension['tokenizer']> = {
  blockquote(src) {
    return blockMarker(src) === '>' ? false : undefined;
  },
  hr(src) {
    if (!(this.rules.block.hr instanceof FirstLineHorizontalRule)) {
      // Lexer rules normally share their block object. Own this replacement so
      // another parser or lexer never inherits a modified static rule table.
      this.rules.block = { ...this.rules.block, hr: new FirstLineHorizontalRule(this.rules.block.hr) };
    }
    const marker = blockMarker(src);
    return marker && '-_*'.includes(marker) ? false : undefined;
  },
  html(src) {
    return blockMarker(src) === '<' ? false : undefined;
  },
  table(src) {
    const lineEnd = src.indexOf('\n');
    if (lineEnd === -1) return undefined;
    return /^ {0,3}[|:-]/.test(src.slice(lineEnd + 1, lineEnd + 5)) ? false : undefined;
  },
  lheading(src) {
    return /\n {0,3}(?:=+|-+) *(?:\n|$)/.test(paragraphWindow(src)) ? false : undefined;
  },
  reflink(src, links) {
    if (!src.startsWith('[') && !src.startsWith('![')) return undefined;
    if (Object.keys(links).length > 0) return false;
    // Without definitions every reference is literal. Consume its first
    // character as marked does for an unresolved reference, without matching
    // a possibly message-sized label first.
    const raw = src.charAt(0);
    return { type: 'text', raw, text: raw };
  },
  url(src) {
    if (/^(?:https?:\/\/|ftp:\/\/|www\.)/i.test(src.slice(0, 8))) return false;
    // Only the initial email-local-part run can lead to a bare email. Looking
    // for @ anywhere in the remaining paragraph would repeat the same scan.
    const local = /^[A-Za-z0-9._+-]+/.exec(src)?.[0];
    return local && src.charAt(local.length) === '@' ? false : undefined;
  },
};

// marked-linkify-it searches the remaining inline text at every token. A long
// paragraph uses marked's GFM autolink until this bounded suffix is reached.
export const LINKIFY_SOURCE_LIMIT = 5_000;

// Only session/message deep links become bare openchamber: links.
const OPENCHAMBER_SESSION_LINK_TAIL = /^\/\/session\/[A-Za-z0-9_-]{1,128}(?:\?message=[A-Za-z0-9_-]{1,128})?/;
const OPENCHAMBER_SESSION_LINK_SCHEMA = {
  validate: (text: string, pos: number): number => OPENCHAMBER_SESSION_LINK_TAIL.exec(text.slice(pos))?.[0].length ?? 0,
};

// With fuzzyLink off, schemes contain :, protocol-relative URLs start with //,
// and email addresses contain @. Keep this in sync with the options/schemas.
const LINK_MARKER = /[:/@]/;

export const boundedLinkify = (): MarkedExtension => ({
  extensions: (markedLinkifyIt({ fuzzyLink: false, schemas: { 'openchamber:': OPENCHAMBER_SESSION_LINK_SCHEMA } }).extensions ?? []).map((extension) => {
    if (!('tokenizer' in extension)) return extension;
    const { start, tokenizer } = extension;
    return {
      ...extension,
      start(src) {
        if (src.length > LINKIFY_SOURCE_LIMIT || !LINK_MARKER.test(src)) return undefined;
        scanStats.linkify += src.length;
        return start?.call(this, src);
      },
      tokenizer(src, tokens) {
        if (src.length > LINKIFY_SOURCE_LIMIT || !LINK_MARKER.test(src)) return undefined;
        scanStats.linkify += src.length;
        return tokenizer.call(this, src, tokens);
      },
    };
  }),
});
