import type { BotArtifact } from '@/lib/bots/artifacts';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export function RetainedPageNotice({ assets, className }: {
    readonly assets: BotArtifact['incompleteAssets'];
    readonly className?: string;
}) {
    const { t } = useI18n();
    if (assets.length === 0) return null;
    return (
        <div role="status" data-retained-page-incomplete="" className={cn('rounded-md bg-[var(--status-warning-background)] px-3 py-2 typography-meta text-[var(--status-warning-text)]', className)}>
            <p>{t('bots.artifacts.incomplete')}</p>
            <ul className="mt-1 space-y-1">
                {assets.map((asset) => <li key={asset.source} className="break-all" dir="auto">{asset.source}</li>)}
            </ul>
        </div>
    );
}
