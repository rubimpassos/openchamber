import React from 'react';
import {
  SettingsCheckboxRow, SettingsChipGroup, SettingsFieldRow, SettingsStackedField,
  SETTINGS_FIELDS_STACK_CLASS, SETTINGS_NUMBER_INPUT_CLASS, SETTINGS_SELECT_TRIGGER_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { Input } from '@/components/ui/input';
import { NumberInput } from '@/components/ui/number-input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';
import { parseFixLoopAuthors, type FixLoopConfig } from '@/lib/prFixLoop';

/** Text stays editable until blur, so a comma or a space can be typed in an author list. */
function ConfigTextInput({ value, onCommit, label, disabled, placeholder, name, required = false }: {
  value: string; onCommit: (value: string) => void; label: string; disabled: boolean; placeholder?: string;
  name: 'allowAuthors' | 'blockAuthors' | 'mentionText';
  required?: boolean;
}) {
  const [draft, setDraft] = React.useState(value);
  React.useEffect(() => setDraft(value), [value]);
  return <Input dir="ltr" name={name} value={draft} disabled={disabled} aria-label={label} placeholder={placeholder}
    required={required} pattern={required ? '.*\\S.*' : undefined}
    onChange={(event) => setDraft(event.target.value)} onBlur={() => onCommit(draft)} />;
}

/** Same controls for saved defaults and a loop's own configuration. */
export function PrFixLoopConfigFields({ config, onChange, disabled = false, settings = false, executionModeLocked = false }: {
  config: FixLoopConfig;
  onChange: (patch: Partial<FixLoopConfig>) => void;
  disabled?: boolean;
  settings?: boolean;
  executionModeLocked?: boolean;
}) {
  const { t } = useI18n();
  const anchor = (field: keyof FixLoopConfig) => settings ? `integrations.pr-fix-loop.${field}` : undefined;
  return (
    <div className={SETTINGS_FIELDS_STACK_CLASS}>
      <SettingsCheckboxRow checked={config.watch === true} disabled={disabled} onChange={(watch) => onChange({ watch })}
        label={t('prFixLoop.config.watch')} info={t('prFixLoop.config.watch.info')} settingsItem={anchor('watch')} />
      <SettingsFieldRow label={t('prFixLoop.config.maxIterations')} info={t('prFixLoop.config.maxIterations.info')} settingsItem={anchor('maxIterations')}>
        <NumberInput value={config.maxIterations} min={1} max={50} step={1} disabled={disabled}
          aria-label={t('prFixLoop.config.maxIterations')} containerClassName={SETTINGS_NUMBER_INPUT_CLASS}
          onValueChange={(maxIterations) => onChange({ maxIterations })} />
      </SettingsFieldRow>
      <SettingsFieldRow label={t('prFixLoop.config.tokenBudget')} info={t('prFixLoop.config.tokenBudget.info')} settingsItem={anchor('tokenBudget')}>
        <NumberInput value={config.tokenBudget ?? undefined} min={1} step={1000} disabled={disabled}
          aria-label={t('prFixLoop.config.tokenBudget')} containerClassName={SETTINGS_NUMBER_INPUT_CLASS}
          emptyLabel={t('prFixLoop.config.unlimited')} onClear={() => onChange({ tokenBudget: null })}
          onValueChange={(tokenBudget) => onChange({ tokenBudget })} />
      </SettingsFieldRow>
      <SettingsStackedField label={t('prFixLoop.config.triggers')} info={t('prFixLoop.config.triggers.info')} settingsItem={anchor('triggers')}>
        <SettingsChipGroup value={config.triggers} aria-label={t('prFixLoop.config.triggers')}
          onChange={(triggers) => onChange({ triggers })} options={[
            { value: 'both', label: t('prFixLoop.config.triggers.both'), disabled },
            { value: 'ci', label: t('prFixLoop.config.triggers.ci'), disabled },
            { value: 'review', label: t('prFixLoop.config.triggers.review'), disabled },
          ]} />
      </SettingsStackedField>
      <SettingsCheckboxRow checked={config.ignoreSelf} disabled={disabled} onChange={(ignoreSelf) => onChange({ ignoreSelf })}
        label={t('prFixLoop.config.ignoreSelf')} info={t('prFixLoop.config.ignoreSelf.info')} settingsItem={anchor('ignoreSelf')} />
      <SettingsCheckboxRow checked={config.ignoreBots} disabled={disabled} onChange={(ignoreBots) => onChange({ ignoreBots })}
        label={t('prFixLoop.config.ignoreBots')} settingsItem={anchor('ignoreBots')} />
      <SettingsStackedField label={t('prFixLoop.config.allowAuthors')} info={t('prFixLoop.config.allowAuthors.info')} settingsItem={anchor('allowAuthors')}>
        <ConfigTextInput name="allowAuthors" value={config.allowAuthors.join(', ')} disabled={disabled} label={t('prFixLoop.config.allowAuthors')}
          onCommit={(value) => onChange({ allowAuthors: parseFixLoopAuthors(value) })} />
      </SettingsStackedField>
      <SettingsStackedField label={t('prFixLoop.config.blockAuthors')} info={t('prFixLoop.config.blockAuthors.info')} settingsItem={anchor('blockAuthors')}>
        <ConfigTextInput name="blockAuthors" value={config.blockAuthors.join(', ')} disabled={disabled} label={t('prFixLoop.config.blockAuthors')}
          onCommit={(value) => onChange({ blockAuthors: parseFixLoopAuthors(value) })} />
      </SettingsStackedField>
      <SettingsCheckboxRow checked={config.mentionOnly} disabled={disabled} onChange={(mentionOnly) => onChange({ mentionOnly })}
        label={t('prFixLoop.config.mentionOnly')} settingsItem={anchor('mentionOnly')} />
      <SettingsStackedField label={t('prFixLoop.config.mentionText')} settingsItem={anchor('mentionText')}>
        <ConfigTextInput name="mentionText" value={config.mentionText} disabled={disabled} required={config.mentionOnly} label={t('prFixLoop.config.mentionText')}
          placeholder="@openchamber" onCommit={(mentionText) => onChange({ mentionText })} />
      </SettingsStackedField>
      <SettingsStackedField label={t('prFixLoop.config.pushMode')} info={t('prFixLoop.config.pushMode.info')} settingsItem={anchor('pushMode')}>
        <Select value={config.pushMode} disabled={disabled || executionModeLocked} onValueChange={(value) => {
          if (value === 'auto' || value === 'approval') onChange({ pushMode: value });
        }}>
          <SelectTrigger className={SETTINGS_SELECT_TRIGGER_CLASS} aria-label={t('prFixLoop.config.pushMode')}>
            <SelectValue>{t(config.pushMode === 'auto' ? 'prFixLoop.config.pushMode.auto' : 'prFixLoop.config.pushMode.approval')}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">{t('prFixLoop.config.pushMode.auto')}</SelectItem>
            <SelectItem value="approval">{t('prFixLoop.config.pushMode.approval')}</SelectItem>
          </SelectContent>
        </Select>
      </SettingsStackedField>
    </div>
  );
}
