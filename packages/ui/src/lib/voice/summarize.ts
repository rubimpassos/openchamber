export function sanitizeForTTS(text: string): string {
    if (!text) return '';
    return text
        .replace(/```[\s\S]*?```/g, '')
        // HTML comments and tags go, the text between tags stays. Inline code
        // is matched first so a tag written as code ("use `<details>`") is
        // still read.
        .replace(/(`[^`\n]*`)|<!--[\s\S]*?-->|<\/?[A-Za-z][\w:-]*(?:\s[^<>]*)?\/?>/g, (_match, code?: string) => code ?? ' ')
        .replace(/`([^`\n]*)`/g, '$1')
        .replace(/[*_~#]/g, '')
        .replace(/https?:\/\/[^\s]+/g, '')
        .replace(/(^|\s)\/(?:[\w.-]+\/)*[\w.-]+/g, '$1')
        .replace(/([\w.])\/([\w.])/g, '$1 slash $2')
        .replace(/^\s*[$#>]\s*/gm, '')
        .replace(/[[\]{}()<>|&;]/g, ' ')
        .replace(/\\/g, '')
        .replace(/\r\n?/g, '\n')
        .replace(/[^\S\n]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/\n+/g, '\n')
        .trim();
}

export function ensureLineTerminalPunctuation(text: string): string {
    return text
        .split('\n')
        .map((line) => (/[\p{L}\p{N}]$/u.test(line) ? line + '.' : line))
        .join('\n');
}
