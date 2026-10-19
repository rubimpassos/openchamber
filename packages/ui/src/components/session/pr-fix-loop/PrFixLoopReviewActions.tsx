import React from 'react';
import { useI18n } from '@/lib/i18n';
import type { FixLoop } from '@/lib/prFixLoop';

type Review = NonNullable<FixLoop['review']>;
const targetKeys = {
  thread: 'prFixLoop.review.thread', review: 'prFixLoop.review.review', comment: 'prFixLoop.review.comment',
} as const satisfies Record<Review['actions'][number]['kind'], string>;

/** Frozen worker text is quoted as data, with no Markdown or executable markup. */
export function PrFixLoopReviewActions({ review }: { readonly review: Review }) {
  const { t } = useI18n();
  return <section aria-label={t('prFixLoop.review.title')} className="min-w-0 space-y-3">
    <h3 className="typography-ui-label text-foreground">{t('prFixLoop.review.title')}</h3>
    <p className="typography-meta text-muted-foreground">{t('prFixLoop.review.description')}</p>
    <p className="typography-meta text-muted-foreground">{t('prFixLoop.review.marker')}</p>
    <ol className="min-w-0 space-y-4">
      {review.actions.map((action) => {
        let resolution: string | null;
        switch (action.kind) {
          case 'thread': resolution = t(action.resolve ? 'prFixLoop.review.resolve' : 'prFixLoop.review.keepOpen'); break;
          case 'review':
          case 'comment': resolution = null; break;
          default: { const unreachable: never = action; return unreachable; }
        }
        return <li key={`${action.kind}:${action.id}`} className="min-w-0 space-y-2 border-t border-border pt-3">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 typography-meta text-muted-foreground">
            <span>{t(targetKeys[action.kind])}</span>
            <bdi dir="ltr" className="break-all font-mono">{action.id}</bdi>
          </div>
          {resolution ? <p className="typography-meta text-muted-foreground">{resolution}</p> : null}
          <blockquote dir="auto" className="oc-ui-start-align whitespace-pre-wrap break-words text-sm text-foreground">{action.body}</blockquote>
        </li>;
      })}
    </ol>
  </section>;
}
