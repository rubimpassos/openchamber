import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import type { GitHubPullReference, PullStackMember } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { ChecksGlyph } from './ReferencePickerRow';
import { githubStateLook } from './referencePickerItems';

export function PullStackMemberRow({ member, reference, current, busy, onOpen, onRetarget }: {
  member: PullStackMember; reference: GitHubPullReference; current: boolean; busy: boolean;
  onOpen: () => void; onRetarget: () => void;
}) {
  const { t } = useI18n();
  const look = githubStateLook({ ...reference, ...member }, { ...reference.sourceRepo, ...member });
  const unknown = member.summary === 'unknown';
  const color = unknown && member.state === 'open' ? 'var(--surface-muted-foreground)' : look.color;
  return (
    <li className={cn('min-w-0 rounded-md px-2 py-1.5', current && 'bg-interactive-selection/60')}>
      <Button variant="ghost" size="sm" onClick={onOpen} className="w-full min-w-0 justify-start text-start">
        <Icon name={look.icon} className="size-3.5" style={{ color }} />
        <span dir="ltr" className="shrink-0 font-mono">#{member.number}</span>
        <span dir="auto" className="min-w-0 truncate oc-ui-start-align">{member.title}</span>
        {current ? <span className="ms-auto shrink-0 typography-micro text-muted-foreground">{t('prStacks.current')}</span> : null}
      </Button>
      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 typography-meta text-muted-foreground">
        <span style={{ color }}>{t(look.labelKey)}</span>
        <code dir="ltr" className="min-w-0 break-all">{member.head} → {member.base}</code>
        {unknown ? <span>{t('prStacks.unknown')}</span> : (
          <>
            <span className="inline-flex items-center gap-1">
              <ChecksGlyph checks={member.checks} />
              {member.checks && member.checks.state !== 'unknown'
                ? `${member.checks.success}/${member.checks.total} ${t('gitView.pr.checks.label')}` : t('prStacks.checksUnknown')}
            </span>
            {member.state === 'open' && member.mergeable === null ? <span>{t('prStacks.mergeabilityUnknown')}</span> : null}
          </>
        )}
        {member.state === 'open' ? member.behindBase === null
          ? <span>{t('prStacks.behindUnknown')}</span>
          : member.behindBase > 0 ? <span className="text-[var(--status-warning-text)]">{t(member.behindBase === 1 ? 'prStacks.behindSingle' : 'prStacks.behindPlural', { count: member.behindBase })}</span> : null : null}
        {member.mergedParent && !member.retargetTo && member.state === 'open' ? (
          <span className="text-[var(--status-warning-text)]">{t('prStacks.carriesMerged', { number: member.mergedParent.number })}</span>
        ) : null}
        {member.retargetTo && member.state === 'open' ? (
          <>
            <span className="text-[var(--status-warning-text)]">{t('prStacks.retargetTo', { base: member.retargetTo })}</span>
            <Button variant="outline" size="xs" disabled={busy} onClick={onRetarget}>{t('prStacks.retarget')}</Button>
          </>
        ) : null}
      </div>
    </li>
  );
}
