import React from 'react';
import { RepositoryConfigurationDialog } from '@/components/sections/openchamber/SourceControlBindingSettings';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';

export function PrFixLoopGitSetup({ directory }: { readonly directory: string }) {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  return <div className="space-y-2">
    <p className="typography-meta text-muted-foreground">{t('prFixLoop.worker.gitRequired')}</p>
    <Button size="sm" variant="chip" aria-pressed={open} onClick={() => setOpen((value) => !value)}>{t('gitView.context.configure')}</Button>
    <RepositoryConfigurationDialog open={open} onOpenChange={setOpen} directory={directory} />
  </div>;
}
