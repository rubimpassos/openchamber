import { Icon } from '@/components/icon/Icon';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { BotDefinition } from '@/lib/bots/config';
import { useI18n } from '@/lib/i18n';

type Artifacts = BotDefinition['artifacts'];
const MAX_ARTIFACTS = 20;

const idFor = (label: string, taken: ReadonlySet<string>) => {
  const slug = label.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 56).replace(/-$/, '');
  const base = slug || 'artifact';
  for (let copy = 1; ; copy += 1) {
    const id = copy === 1 ? base : `${base}-${copy}`;
    if (!taken.has(id)) return id;
  }
};

export function BotArtifactsFields({ value, fixedIds, onChange }: {
  readonly value: Artifacts; readonly fixedIds: readonly string[]; readonly onChange: (artifacts: Artifacts) => void;
}) {
  const { t } = useI18n();
  const othersOf = (index: number) => new Set(value.filter((_, row) => row !== index).map((entry) => entry.id));
  const relabel = (index: number, label: string) => onChange(value.map((entry, row) => row !== index ? entry
    : { id: fixedIds.includes(entry.id) ? entry.id : idFor(label, othersOf(index)), label }));
  return <SettingsSection title={t('bots.config.artifacts.title')} description={t('bots.config.artifacts.help')} contentClassName="space-y-2">
    {value.map((artifact, index) => <div key={index} className="flex min-w-0 items-center gap-2">
      <Input required maxLength={500} className="min-w-0 flex-1" aria-label={t('bots.config.artifacts.label', { number: index + 1 })}
        value={artifact.label} onChange={(event) => relabel(index, event.target.value)} />
      <Button variant="ghost" className="shrink-0" aria-label={t('bots.config.artifacts.removeNamed', { number: index + 1 })}
        onClick={() => onChange(value.filter((_, row) => row !== index))}>{t('bots.config.action.remove')}</Button>
    </div>)}
    <Button variant="outline" disabled={value.length >= MAX_ARTIFACTS}
      onClick={() => onChange([...value, { id: idFor('', othersOf(-1)), label: '' }])}><Icon name="add" />{t('bots.config.artifacts.add')}</Button>
  </SettingsSection>;
}
