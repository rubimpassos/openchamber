import React from 'react';
import { Button } from '@/components/ui/button';
import { SortableTabsStrip } from '@/components/ui/sortable-tabs-strip';
import { useI18n } from '@/lib/i18n';
import { botDefinitionSchema, type BotDefinition } from '@/lib/bots/config';
import { BotSourceFields } from './BotSourceFields';
import { BotModelFields } from './BotModelFields';
import { BotExecutionFields } from './BotExecutionFields';
import { BotConnectorsFields, type BotConnector } from './BotConnectorsFields';
import { BotProjectsFields } from './BotProjectsFields';
import { useBotAction } from './useBotRequest';

export function BotEditor({ projectId, directory, initial, onSave, onRemove, onClose, onManageIdentities, identitiesVersion }: {
  readonly projectId: string; readonly directory: string; readonly initial: BotDefinition;
  readonly onSave: (bot: BotDefinition) => Promise<void>;
  readonly onRemove?: () => Promise<void>;
  readonly onClose: () => void; readonly onManageIdentities: () => void;
  readonly identitiesVersion: number;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = React.useState(initial);
  const [tab, setTab] = React.useState('mission');
  const [addedConnectors, setAddedConnectors] = React.useState<readonly BotConnector[]>([]);
  const [removing, setRemoving] = React.useState(false);
  const action = useBotAction();
  const update = (patch: Partial<BotDefinition>) => setDraft((bot) => ({ ...bot, ...patch }));
  const save = () => action.run(async () => {
    await onSave(botDefinitionSchema.parse(draft));
    if (action.isActive()) onClose();
  });
  const remove = () => action.run(async () => {
    await onRemove?.();
    if (action.isActive()) onClose();
  });
  const unreachable = Object.keys(draft.projects).length === 0;
  return <div className="@container space-y-4">
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
      <Button variant="ghost" size="sm" onClick={onClose} disabled={action.busy}>{t('bots.back')}</Button>
      {removing && onRemove ? <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
        <span className="typography-meta text-[var(--status-warning-text)]">{t('bots.config.deleteConfirm')}</span>
        <Button size="sm" variant="destructive" disabled={action.busy} onClick={() => void remove()}>{t('settings.common.actions.delete')}</Button>
        <Button size="sm" variant="ghost" disabled={action.busy} onClick={() => setRemoving(false)}>{t('settings.common.actions.cancel')}</Button>
      </div> : <div className="flex items-center gap-2">
        {onRemove ? <Button size="sm" variant="ghost" disabled={action.busy} onClick={() => setRemoving(true)}>{t('bots.config.delete')}</Button> : null}
        <Button size="sm" disabled={action.busy} onClick={() => void save()}>{t('settings.common.actions.saveChanges')}</Button>
      </div>}
    </div>
    <div className="min-h-5 typography-meta" role={action.error ? 'alert' : 'status'}>
      {action.error ? <span className="text-[var(--status-error-text)]">{action.error}</span>
        : unreachable ? <span className="text-[var(--status-warning-text)]">{t('bots.config.noProjects')}</span> : null}
    </div>
    <SortableTabsStrip variant="active-pill" pillSize="form" className="h-8" activeId={tab} onSelect={setTab} items={[
      { id: 'mission', label: t('bots.mission') }, { id: 'projects', label: t('bots.config.tab.projects') },
      { id: 'connectors', label: t('bots.config.tab.connectors') }, { id: 'models', label: t('bots.models') },
      { id: 'execution', label: t('bots.execution') },
    ]} />
    <fieldset disabled={action.busy} className="min-w-0">
      {tab === 'mission' ? <BotSourceFields bot={draft} fixedArtifactIds={initial.artifacts.map((artifact) => artifact.id)} onChange={update} /> : null}
      {tab === 'projects' ? <BotProjectsFields value={draft.projects} onChange={(projects) => update({ projects })} /> : null}
      {tab === 'connectors' ? <BotConnectorsFields key={identitiesVersion} projectId={projectId} bot={draft} added={addedConnectors} onAdded={setAddedConnectors}
        onChange={update} onManage={onManageIdentities} /> : null}
      {tab === 'models' ? <BotModelFields bot={draft} directory={directory} onChange={(models) => update({ models })} /> : null}
      {tab === 'execution' ? <BotExecutionFields bot={draft} directory={directory} onChange={update} /> : null}
    </fieldset>
  </div>;
}
