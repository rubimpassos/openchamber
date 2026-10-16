import React from 'react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { useI18n, type I18nKey } from '@/lib/i18n';

const QUICK_REASONS: I18nKey[] = [
  'suggestedTasks.dismiss.reason.notAProblem',
  'suggestedTasks.dismiss.reason.wontFix',
  'suggestedTasks.dismiss.reason.alreadyDone',
  'suggestedTasks.dismiss.reason.tooVague',
];

/**
 * Asks why a suggestion is dismissed. The reason is optional; when given,
 * the next scans read it and stop proposing the same kind of thing.
 */
export const DismissSuggestionDialog: React.FC<{
  title: string | null;
  onOpenChange: (open: boolean) => void;
  onDismiss: (reason: string) => Promise<boolean>;
}> = ({ title, onOpenChange, onDismiss }) => {
  const { t } = useI18n();
  const [reason, setReason] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const active = React.useRef(true);
  const submitting = React.useRef(false);
  React.useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  React.useEffect(() => {
    if (title !== null) setReason('');
  }, [title]);

  const submit = async () => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    try {
      if (await onDismiss(reason.trim()) && active.current) onOpenChange(false);
    } finally {
      submitting.current = false;
      if (active.current) setBusy(false);
    }
  };

  return (
    <Dialog open={title !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('suggestedTasks.dismiss.title')}</DialogTitle>
          <DialogDescription dir="auto" className="oc-ui-start-align">{title}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div role="group" aria-label={t('suggestedTasks.dismiss.quickReasons')} className="flex flex-wrap gap-1">
            {QUICK_REASONS.map((key) => (
              <Button
                key={key}
                type="button"
                variant="chip"
                size="xs"
                disabled={busy}
                className="!font-normal"
                aria-pressed={reason === t(key)}
                onClick={() => setReason(t(key))}
              >
                {t(key)}
              </Button>
            ))}
          </div>
          <Textarea
            value={reason}
            disabled={busy}
            onChange={(event) => setReason(event.target.value)}
            placeholder={t('suggestedTasks.dismiss.placeholder')}
            aria-label={t('suggestedTasks.dismiss.reasonLabel')}
            maxLength={500}
            className="min-h-[88px]"
          />
          <p className="typography-meta text-muted-foreground">{t('suggestedTasks.dismiss.hint')}</p>
        </div>
        <DialogFooter>
          <Button type="button" size="sm" variant="outline" onClick={() => onOpenChange(false)}>{t('dialog.common.actions.cancel')}</Button>
          <Button type="button" size="sm" disabled={busy} onClick={() => void submit()}>{t('suggestedTasks.dismiss.confirm')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
