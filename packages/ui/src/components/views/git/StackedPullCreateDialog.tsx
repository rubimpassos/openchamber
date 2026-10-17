import * as React from 'react';
import { useMobileAppActions } from '@/apps/mobileAppContext';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { GitStatus, PullStack } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useUIStore } from '@/stores/useUIStore';
import { PullRequestSection } from './PullRequestSection';

/** Reuses the Git create form on every runtime, including the phone shell without a PR rail. */
export function StackedPullCreateDialog({ directory, stack, onClose }: { directory: string; stack: PullStack; onClose: () => void }) {
  const { git } = useRuntimeAPIs();
  const { t } = useI18n();
  const mobile = useMobileAppActions();
  const [status, setStatus] = React.useState<GitStatus | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [revision, refresh] = React.useReducer((value: number) => value + 1, 0);
  React.useEffect(() => {
    let active = true;
    const runtime = getRuntimeKey();
    void git.getGitStatus(directory).then((value) => { if (active && getRuntimeKey() === runtime) { setStatus(value); setError(null); } })
      .catch((failure) => { if (active) setError(failure instanceof Error ? failure.message : String(failure)); });
    return () => { active = false; };
  }, [directory, git, revision]);
  const top = stack.members.filter((member) => member.state === 'open').at(-1);
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="flex max-h-[90dvh] max-w-2xl flex-col overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('prStacks.onTop')}</DialogTitle>
          <DialogDescription>{t('prStacks.chooseBranch')}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => {
            onClose();
            if (mobile) mobile.openChanges();
            else useUIStore.getState().openContextSurface(directory, 'git');
          }}><Icon name="git-branch" className="size-3.5" />{t('mobile.menu.git')}</Button>
          <Button size="sm" variant="ghost" onClick={refresh}><Icon name="refresh" className="size-3.5" />{t('references.picker.preview.refresh')}</Button>
        </div>
        {error ? <p role="alert" className="break-words typography-meta text-[var(--status-error-text)]">{error}</p> : null}
        {status && top ? <PullRequestSection key={status.current} directory={directory} branch={status.current} baseBranch={stack.trunk}
          trackingBranch={status.tracking ?? undefined} ahead={status.ahead} stackBase={{ head: top.head, number: top.number }} /> : null}
      </DialogContent>
    </Dialog>
  );
}
