import type { I18nKey, useI18n } from '@/lib/i18n';
import type { OpenChamberResume } from '@/lib/opencode/openchamber-resume';

type FixLoopNotice = Extract<OpenChamberResume, { kind: 'fix-loop' }>;

const FIX_LOOP_TITLE_KEYS = {
    ci: 'chat.openchamberNotice.fixLoop.ci',
    review: 'chat.openchamberNotice.fixLoop.review',
    'ci+review': 'chat.openchamberNotice.fixLoop.both',
} as const satisfies Record<Exclude<FixLoopNotice['trigger'], 'unknown'>, I18nKey>;

const MAX_TITLE_AUTHORS = 3;

/** "Fix loop: CI failed on #5 · 1a2b3c4 · @reviewer · iteration 1/10", leaving out what the notice lacks. */
export const fixLoopTitle = (notice: FixLoopNotice, t: ReturnType<typeof useI18n>['t']): string => {
    const number = notice.pr?.number;
    const main = notice.trigger === 'unknown' || number === undefined
        ? t('chat.openchamberNotice.fixLoop.generic')
        : t(FIX_LOOP_TITLE_KEYS[notice.trigger], { number });
    const authors = [...new Set(notice.feedback.map((entry) => `@${entry.author}`))];
    const shownAuthors = authors.length > MAX_TITLE_AUTHORS
        ? `${authors.slice(0, MAX_TITLE_AUTHORS).join(', ')} +${authors.length - MAX_TITLE_AUTHORS}`
        : authors.join(', ');
    const segments = [
        main,
        notice.headSha ? notice.headSha.slice(0, 7) : null,
        shownAuthors || null,
        notice.iteration && notice.maxIterations
            ? t('chat.openchamberNotice.fixLoop.iteration', { current: notice.iteration, max: notice.maxIterations })
            : null,
    ];
    return segments.filter(Boolean).join(' · ');
};
