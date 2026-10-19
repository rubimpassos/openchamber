export type SpeechSegment =
    | { kind: 'prose'; text: string }
    | { kind: 'table'; markdown: string; context: string; description: string | null };

/** Enough of the prose before a table for a model to say what it is about. */
const TABLE_CONTEXT_CHARS = 600;

const FENCE = /^\s*(```|~~~)/;
const DELIMITER_ROW = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
/**
 * The spoken description agents put above a table when read aloud is on
 * (`TABLE_SPEECH_GUIDANCE` in the server's session knowledge). It is a
 * markdown link definition, so the chat renders it as nothing.
 */
const SPEECH_DESCRIPTION = /^\s{0,3}\[oc-tts\]:\s*#\s+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\))\s*$/;

const isTableRow = (line: string | undefined): boolean => Boolean(line?.includes('|') && line.trim());

/**
 * Split markdown into prose and GFM tables, in reading order. A table is a
 * row with a `|`, a delimiter row such as `|---|:--:|`, and the rows that
 * follow it; tables inside fenced code stay in the prose. A description line
 * is never spoken as prose; the one right above a table, blank lines
 * between allowed, becomes that table's description.
 */
export function splitTablesForSpeech(markdown: string): SpeechSegment[] {
    const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
    const segments: SpeechSegment[] = [];
    let prose: string[] = [];
    let spokenBefore = '';
    let inFence = false;
    let description: string | null = null;

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

        const describes = inFence ? null : SPEECH_DESCRIPTION.exec(line);
        if (describes) {
            const sentence = (describes[1] ?? describes[2] ?? describes[3] ?? '').trim();
            description = sentence || null;
            continue;
        }

        const delimiter = lines[index + 1];
        const startsTable = !inFence
            && isTableRow(line)
            && delimiter !== undefined
            && delimiter.includes('|')
            && DELIMITER_ROW.test(delimiter);
        if (!startsTable) {
            prose.push(line);
            if (line.trim()) description = null;
            continue;
        }

        let end = index + 2;
        while (isTableRow(lines[end])) end += 1;
        flushProse();
        segments.push({
            kind: 'table',
            markdown: lines.slice(index, end).join('\n'),
            context: spokenBefore.trim(),
            description,
        });
        description = null;
        index = end - 1;
    }
    flushProse();
    return segments;
}
