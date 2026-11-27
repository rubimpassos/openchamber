import React from 'react';
import { ProjectLabel } from '@/components/layout/ProjectRailPage';
import { useProjectsInSidebarOrder } from '@/components/session/sidebar/list/useProjectsInSidebarOrder';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { useBotsRuntime } from '@/lib/botsRuntime';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { BotsProject } from './BotsProject';
import { BotsShell } from './BotsShell';

function BotsRuntimeView({ layout, onLeave }: { readonly layout: 'page' | 'mobile'; readonly onLeave: () => void }) {
  const { t } = useI18n();
  const projects = useProjectsInSidebarOrder(useProjectsStore((state) => state.projects));
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const target = useUIStore((state) => state.botsPageTarget);
  const [selectedId, setSelectedId] = React.useState(target?.projectId ?? activeProjectId);
  React.useEffect(() => { if (target) setSelectedId(target.projectId); }, [target]);
  const project = projects.find((entry) => entry.id === (target?.projectId ?? selectedId))
    ?? (target ? undefined : projects.find((entry) => entry.id === activeProjectId) ?? projects[0]);
  const selectProject = (id: string) => { setSelectedId(id); useUIStore.getState().setBotsPageTarget(null); };
  const picker = <Select value={project?.id} onValueChange={selectProject}>
    <SelectTrigger className="max-w-full" aria-label={t('suggestedTasks.page.project')}><SelectValue>{() => project ? <ProjectLabel project={project} /> : t('bots.noProject')}</SelectValue></SelectTrigger>
    <SelectContent>{projects.map((entry) => <SelectItem key={entry.id} value={entry.id}><ProjectLabel project={entry} /></SelectItem>)}</SelectContent>
  </Select>;
  return project
    ? <BotsProject key={`${project.id}:${project.path}`} project={project} layout={layout} picker={picker} onLeave={onLeave} initialItemId={target?.projectId === project.id ? target.itemId : undefined} initialBotId={target?.projectId === project.id ? target.botId : undefined} initialNewBot={target?.projectId === project.id && target.newBot === true} />
    : <BotsShell layout={layout} picker={picker}><p className="typography-meta text-muted-foreground">{target ? t('common.unavailable') : t('bots.noProject')}</p></BotsShell>;
}

/** Explicitly absent in VS Code, which owns no OpenChamber bots server. */
export function BotsView(props: React.ComponentProps<typeof BotsRuntimeView>) {
  const runtime = useBotsRuntime();
  const { t } = useI18n();
  return isVSCodeRuntime() ? <p role="status">{t('bots.unsupported')}</p> : <BotsRuntimeView key={runtime.generation} {...props} />;
}

export function BotsPage() {
  const open = useUIStore((state) => state.isBotsPageOpen);
  const setOpen = useUIStore((state) => state.setBotsPageOpen);
  return open ? <BotsView layout="page" onLeave={() => setOpen(false)} /> : null;
}
