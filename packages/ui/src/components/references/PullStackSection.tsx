import * as React from 'react';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { useOpenTrackerItem } from '@/components/sourceBoard/openTrackerItem';
import { usePullAttachments } from '@/components/sourceBoard/pullAttachments';
import { newMutationKey } from '@/components/sourceBoard/mutationKey';
import { useOnDemandComponent } from '@/hooks/useOnDemandComponent';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { GitHubPullReference, PullStackMember, SourceControlReadContext } from '@/lib/api/types';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useGitHubReadContext } from './referenceSources';
import { PullStackMemberRow } from './PullStackMemberRow';
import { PullStackMerge } from './PullStackMerge';
import { PullStackRestack } from './PullStackRestack';
import { usePullStack } from './usePullStack';

const loadCreateDialog = () => import('@/components/views/git/StackedPullCreateDialog').then((module) => module.StackedPullCreateDialog);

export function PullStackSection(props: {
  reference: GitHubPullReference; directory: string; enabled?: boolean;
  onOpenMember?: (member: PullStackMember) => void;
  onChanged?: () => void | Promise<void>;
}) {
  if (isVSCodeRuntime() || props.reference.provider === 'gitlab') return null;
  return <BoundPullStackSection {...props} />;
}

function BoundPullStackSection({ reference, directory, enabled = true, onOpenMember, onChanged }: {
  reference: GitHubPullReference; directory: string; enabled?: boolean;
  onOpenMember?: (member: PullStackMember) => void;
  onChanged?: () => void | Promise<void>;
}) {
  const bound = useGitHubReadContext(directory);
  if (!enabled || !bound || bound === 'missing' || bound.provider !== 'github') return null;
  return <StackContents key={JSON.stringify([getRuntimeKey(), bound, reference.number])} reference={reference} context={bound} onOpenMember={onOpenMember} onChanged={onChanged} />;
}

function StackContents({ reference, context, onOpenMember, onChanged }: {
  reference: GitHubPullReference; context: SourceControlReadContext; onOpenMember?: (member: PullStackMember) => void;
  onChanged?: () => void | Promise<void>;
}) {
  const { t } = useI18n();
  const { sourceControl } = useRuntimeAPIs();
  const pull = React.useMemo(() => ({ ...reference.sourceRepo, number: reference.number }), [reference.number, reference.sourceRepo]);
  const state = usePullStack(context, pull);
  const { refresh: refreshStack } = state;
  const openTrackerItem = useOpenTrackerItem();
  const attachments = usePullAttachments(reference);
  const [busy, setBusy] = React.useState(false);
  const [createOpen, setCreateOpen] = React.useState(false);
  const CreateDialog = useOnDemandComponent(createOpen, loadCreateDialog, () => { setCreateOpen(false); toast.error(t('prStacks.actionFailed')); });
  const refresh = React.useCallback(() => {
    if (onChanged) void Promise.resolve(onChanged()).then(refreshStack, refreshStack);
    else refreshStack();
  }, [onChanged, refreshStack]);
  const retarget = async (member: PullStackMember) => {
    if (!member.retargetTo || busy) return;
    const runtime = getRuntimeKey();
    setBusy(true);
    try {
      await sourceControl.githubPullStackRetarget({ ...context, idempotencyKey: newMutationKey(),
        target: { project: { owner: pull.owner, name: pull.repo }, number: member.number, head: member.head, base: member.base, headSha: member.headSha },
      }, { ...pull, number: member.number, base: member.retargetTo });
      if (getRuntimeKey() === runtime) refresh();
    } catch (error) {
      if (getRuntimeKey() === runtime) toast.error(t('prStacks.actionFailed'), { description: error instanceof Error ? error.message : String(error) });
    } finally { setBusy(false); }
  };
  const stack = state.stack;
  if (!stack && state.status !== 'error') return null;
  return (
    <section className="flex min-w-0 flex-col gap-3 border-t border-border/60 pt-4" aria-label={t('prStacks.title')}>
      <div className="flex flex-wrap items-center gap-2">
        <Icon name="stack" className="size-4 text-muted-foreground" />
        <h4 className="typography-ui-label font-semibold">{t('prStacks.title')}</h4>
        {stack ? <span className="typography-meta text-muted-foreground">{t(stack.source === 'native' ? 'prStacks.native' : 'prStacks.inferred')}{stack.nativeNumber !== null ? ` #${stack.nativeNumber}` : ''}</span> : null}
      </div>
      {state.error ? <div role="alert" className="flex flex-wrap items-center gap-2 typography-meta text-[var(--status-error-text)]">
        <span>{t('references.picker.error.load', { error: state.error })}</span>
        <Button size="sm" variant="outline" onClick={refresh}>{t('references.picker.actions.retry')}</Button>
      </div> : null}
      {stack ? (
        <>
          {stack.nativeUnavailable ? <p className="typography-meta text-muted-foreground">{t('prStacks.nativeUnavailable')}</p> : null}
          <ol className="flex min-w-0 flex-col gap-1" aria-label={t('prStacks.order')}>
            {stack.members.map((member) => <PullStackMemberRow key={member.number} member={member} reference={reference} current={member.number === stack.current} busy={busy || state.status !== 'ready'}
              onOpen={() => onOpenMember ? onOpenMember(member) : openTrackerItem(member.url, context.directory)} onRetarget={() => void retarget(member)} />)}
          </ol>
          {stack.branches.length ? <p className="break-words typography-meta text-muted-foreground">{t('prStacks.extraBranches', { branches: stack.branches.map((branch) => `#${branch.number} ${branch.title}`).join(', ') })}</p> : null}
          <PullStackRestack context={context} stack={stack} pull={pull} onChanged={refresh} enabled={state.status === 'ready'} />
          {state.status === 'ready' ? <>
            <div className="flex flex-wrap items-center gap-2">
              <PullStackMerge context={context} stack={stack} pull={pull} onChanged={refresh} />
              <Button size="sm" variant="outline" onClick={() => setCreateOpen(true)} disabled={!stack.members.some((member) => member.state === 'open')}>
                <Icon name="git-pull-request" className="size-3.5" />{t('prStacks.onTop')}
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => {
                setBusy(true);
                void attachments.attachStack(stack, context).finally(() => setBusy(false));
              }}><Icon name="attachment-2" className="size-3.5" />{t('prStacks.attach')}</Button>
            </div>
          </> : null}
          {CreateDialog && createOpen ? <CreateDialog directory={context.directory} stack={stack} onClose={() => setCreateOpen(false)} /> : null}
        </>
      ) : null}
    </section>
  );
}
