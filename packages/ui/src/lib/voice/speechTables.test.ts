import { describe, expect, test } from 'bun:test';

import { splitTablesForSpeech } from './speechTables';

const table = [
    '| Provider | Latency |',
    '|---|:--:|',
    '| OpenAI | 1.7 s |',
    '| Gemini | 0.9 s |',
].join('\n');

describe('splitTablesForSpeech', () => {
    test('returns prose without tables as one segment', () => {
        expect(splitTablesForSpeech('Just text.\nWith a | pipe.')).toEqual([
            { kind: 'prose', text: 'Just text.\nWith a | pipe.' },
        ]);
    });

    test('separates a table from the prose around it, with the prose before as context', () => {
        const markdown = `I compared the providers.\n\n${table}\n\nOpenAI was slowest.`;
        expect(splitTablesForSpeech(markdown)).toEqual([
            { kind: 'prose', text: 'I compared the providers.' },
            { kind: 'table', markdown: table, context: 'I compared the providers.' },
            { kind: 'prose', text: 'OpenAI was slowest.' },
        ]);
    });

    test('recognizes a table at the very start and without outer pipes', () => {
        const bare = 'A | B\n--- | ---\n1 | 2';
        expect(splitTablesForSpeech(`${bare}\nAfter.`)).toEqual([
            { kind: 'table', markdown: bare, context: '' },
            { kind: 'prose', text: 'After.' },
        ]);
    });

    test('leaves a table inside fenced code in the prose', () => {
        const markdown = `\`\`\`md\n${table}\n\`\`\``;
        expect(splitTablesForSpeech(markdown)).toEqual([{ kind: 'prose', text: markdown }]);
    });

    test('keeps only the last 600 characters of prose as context', () => {
        const long = 'x'.repeat(1000);
        const [, tableSegment] = splitTablesForSpeech(`${long}\n${table}`);
        expect(tableSegment).toEqual({ kind: 'table', markdown: table, context: 'x'.repeat(600) });
    });
});
