import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export function RetainedPagePending({ className }: { readonly className?: string }) {
    const { t } = useI18n();
    return (
        <p role="status" data-retained-page="pending" className={cn('typography-meta text-muted-foreground', className)}>
            {t('common.loading')}
        </p>
    );
}

export function RetainedPageFailure({ retry, className }: {
    readonly retry: (() => void) | null;
    readonly className?: string;
}) {
    const { t } = useI18n();
    return (
        <div role="alert" data-retained-page="failed" className={cn('space-y-2', className)}>
            <p className="typography-meta text-[var(--status-error-text)]">
                {retry ? t('bots.artifacts.viewFailed') : t('bots.artifacts.notRetained')}
            </p>
            {retry ? <Button size="sm" variant="outline" onClick={retry}>{t('bots.retry')}</Button> : null}
        </div>
    );
}
