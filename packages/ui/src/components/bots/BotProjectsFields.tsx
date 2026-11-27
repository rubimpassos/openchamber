import React from 'react';
import { ProjectLabel } from '@/components/layout/ProjectRailPage';
import { SettingsFieldRow, SettingsSection } from '@/components/sections/shared/SettingsSection';
import { useProjectsInSidebarOrder } from '@/components/session/sidebar/list/useProjectsInSidebarOrder';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { BotAccess, BotDefinition } from '@/lib/bots/config';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { formatDirectoryName } from '@/lib/utils';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';

type Choice = BotAccess | 'none';
const CHOICES = ['none', 'read', 'pr', 'merge'] as const satisfies readonly Choice[];
const ACCESS_KEYS = {
  none: 'bots.config.projects.access.none', read: 'bots.config.projects.access.read',
  pr: 'bots.config.projects.access.pr', merge: 'bots.config.projects.access.merge',
} satisfies Record<Choice, I18nKey>;

export function BotAccessLabel({ access }: { readonly access: BotAccess | undefined }) {
  const { t } = useI18n();
  return <>{t(ACCESS_KEYS[access ?? 'none'])}</>;
}

export function BotProjectsFields({ value, onChange }: {
  readonly value: BotDefinition['projects']; readonly onChange: (projects: BotDefinition['projects']) => void;
}) {
  const { t } = useI18n();
  const projects = useProjectsInSidebarOrder(useProjectsStore((state) => state.projects));
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);
  const registered = new Set(projects.map((project) => project.id));
  const rows: { readonly id: string; readonly name: string; readonly label: React.ReactNode }[] = [
    ...projects.map((project) => ({
      id: project.id, name: project.label?.trim() || formatDirectoryName(project.path, homeDirectory || undefined),
      label: <ProjectLabel project={project} />,
    })),
    ...Object.keys(value).filter((id) => !registered.has(id)).map((id) => ({
      id, name: id, label: <span className="truncate" dir="ltr" title={id}>{t('common.unavailable')} · {id}</span>,
    })),
  ];
  const choose = (projectId: string, choice: Choice) => {
    const others = Object.fromEntries(Object.entries(value).filter(([id]) => id !== projectId));
    onChange(choice === 'none' ? others : { ...others, [projectId]: choice });
  };
  return <SettingsSection title={t('bots.config.projects.title')} description={t('bots.config.projects.help')} divider={false}>
    {rows.length === 0 ? <p className="typography-meta text-muted-foreground">{t('bots.noProject')}</p> : null}
    {rows.map((row) => {
      const choice: Choice = value[row.id] ?? 'none';
      return <SettingsFieldRow key={row.id} label={row.label}>
        <Select<Choice> value={choice} onValueChange={(next) => choose(row.id, next)}>
          <SelectTrigger className="max-w-full" aria-label={t('bots.config.projects.accessFor', { project: row.name })}>
            <SelectValue>{() => t(ACCESS_KEYS[choice])}</SelectValue>
          </SelectTrigger>
          <SelectContent>{CHOICES.map((option) => <SelectItem key={option} value={option}>{t(ACCESS_KEYS[option])}</SelectItem>)}</SelectContent>
        </Select>
      </SettingsFieldRow>;
    })}
  </SettingsSection>;
}
