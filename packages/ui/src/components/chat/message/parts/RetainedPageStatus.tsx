import { Button } from '@/components/ui/button';
import type { BotArtifactFailure } from '@/lib/bots/artifacts';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';

const failureKeys = {
    failed: 'bots.artifacts.viewFailed', unavailable: 'bots.artifacts.unavailable', network: 'bots.artifacts.network',
} satisfies Record<BotArtifactFailure, I18nKey>;

export function RetainedPagePending({ className }: { readonly className?: string }) {
    const { t } = useI18n();
    return (
        <p role="status" data-retained-page="pending" className={cn('typography-meta text-muted-foreground', className)}>
            {t('common.loading')}
        </p>
    );
}

export function RetainedPageFailure({ cause, retry, className }: {
    readonly cause: BotArtifactFailure;
    readonly retry: (() => void) | null;
    readonly className?: string;
}) {
    const { t } = useI18n();
    return (
        <div role="alert" data-retained-page="failed" className={cn('space-y-2', className)}>
            <p className="typography-meta text-[var(--status-error-text)]">
                {t(retry ? failureKeys[cause] : 'bots.artifacts.notRetained')}
            </p>
            {retry ? <Button size="sm" variant="outline" onClick={retry}>{t('bots.retry')}</Button> : null}
        </div>
    );
}
