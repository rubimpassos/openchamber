export type SpeechSegment =
    | { kind: 'prose'; text: string }
    | { kind: 'table'; markdown: string; context: string };

/** Enough of the prose before a table for a model to say what it is about. */
const TABLE_CONTEXT_CHARS = 600;

const FENCE = /^\s*(```|~~~)/;
const DELIMITER_ROW = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

const isTableRow = (line: string | undefined): boolean => Boolean(line?.includes('|') && line.trim());

/**
 * Split markdown into prose and GFM tables, in reading order. A table is a
 * row with a `|`, a delimiter row such as `|---|:--:|`, and the rows that
 * follow it; tables inside fenced code stay in the prose.
 */
export function splitTablesForSpeech(markdown: string): SpeechSegment[] {
    const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
    const segments: SpeechSegment[] = [];
    let prose: string[] = [];
    let spokenBefore = '';
    let inFence = false;

    const flushProse = () => {
        const text = prose.join('\n').trim();
        if (text) {
            segments.push({ kind: 'prose', text });
            spokenBefore = `${spokenBefore}\n${text}`.slice(-TABLE_CONTEXT_CHARS);
        }
        prose = [];
    };

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (FENCE.test(line)) inFence = !inFence;

        const delimiter = lines[index + 1];
        const startsTable = !inFence
            && isTableRow(line)
            && delimiter !== undefined
            && delimiter.includes('|')
            && DELIMITER_ROW.test(delimiter);
        if (!startsTable) {
            prose.push(line);
            continue;
        }

        let end = index + 2;
        while (isTableRow(lines[end])) end += 1;
        flushProse();
        segments.push({
            kind: 'table',
            markdown: lines.slice(index, end).join('\n'),
            context: spokenBefore.trim(),
        });
        index = end - 1;
    }
    flushProse();
    return segments;
}
