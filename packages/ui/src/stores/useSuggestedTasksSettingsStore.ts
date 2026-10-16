import { create } from 'zustand';
import {
  fetchSuggestedTasksSettings, saveSuggestedTasksConfig, setRepositoryLensEnabled,
  type SuggestedTasksConfig, type SuggestedTasksSettings,
} from '@/lib/suggestedTasksApi';
import { getSuggestedTasksRuntime, subscribeSuggestedTasksRuntime } from '@/lib/suggestedTasksRuntime';
import { reportSettingsSaveState } from '@/lib/persistence';

type SettingsEntry = {
  readonly settings: SuggestedTasksSettings | null;
  readonly error: string | null;
  readonly saving: boolean;
};

type SettingsEdit = {
  readonly apply: (settings: SuggestedTasksSettings) => SuggestedTasksSettings;
  readonly write: (settings: SuggestedTasksSettings) => Promise<SuggestedTasksSettings>;
};

/** One confirmed snapshot with its admitted, ordered edits. */
type ProjectSettings = {
  confirmed: SuggestedTasksSettings | null;
  pending: SettingsEdit[];
  writes: Promise<void>;
  revision: number;
  read: number;
  error: string | null;
};

type SettingsState = {
  readonly entries: Record<string, SettingsEntry>;
  readonly load: (projectId: string) => Promise<void>;
  readonly updateConfig: (projectId: string, update: (config: SuggestedTasksConfig) => SuggestedTasksConfig) => Promise<boolean>;
  readonly setRepositoryLens: (projectId: string, file: string, enabled: boolean) => Promise<boolean>;
};

export const useSuggestedTasksSettingsStore = create<SettingsState>((set) => {
  const projects = new Map<string, ProjectSettings>();
  subscribeSuggestedTasksRuntime(() => {
    projects.clear();
    set({ entries: {} });
  });
  const projectFor = (projectId: string) => {
    const existing = projects.get(projectId);
    if (existing) return existing;
    const project: ProjectSettings = { confirmed: null, pending: [], writes: Promise.resolve(), revision: 0, read: 0, error: null };
    projects.set(projectId, project);
    return project;
  };
  const publish = (projectId: string, project: ProjectSettings) => {
    const confirmed = project.confirmed;
    const settings = confirmed ? project.pending.reduce((current, edit) => edit.apply(current), confirmed) : null;
    set((state) => ({ entries: { ...state.entries, [projectId]: { settings, error: project.error, saving: project.pending.length > 0 } } }));
  };
  const enqueue = (projectId: string, edit: SettingsEdit): Promise<boolean> => {
    const runtime = getSuggestedTasksRuntime();
    const project = projectFor(projectId);
    if (!project.confirmed) return Promise.resolve(false);
    project.pending.push(edit);
    project.revision += 1;
    publish(projectId, project);
    reportSettingsSaveState('saving');
    const write = project.writes.then(async () => {
      // A project change still writes to its captured project. A host change cancels queued writes.
      if (runtime.signal.aborted || !project.confirmed) return false;
      let saved = false;
      try {
        const settings = await edit.write(edit.apply(project.confirmed));
        if (runtime.signal.aborted) return false;
        project.confirmed = settings;
        project.error = null;
        saved = true;
      } catch (error) {
        if (runtime.signal.aborted) return false;
        project.error = error instanceof Error ? error.message : String(error);
      }
      project.pending.shift();
      project.revision += 1;
      publish(projectId, project);
      reportSettingsSaveState([...projects.values()].some((entry) => entry.pending.length > 0) ? 'saving' : saved ? 'saved' : 'error');
      return saved;
    });
    project.writes = write.then(() => undefined);
    return write;
  };
  return {
    entries: {},
    load: async (projectId) => {
      const runtime = getSuggestedTasksRuntime();
      const project = projectFor(projectId);
      const read = ++project.read;
      // Read after writes already admitted for this owner have finished.
      let writes: Promise<void>;
      do {
        writes = project.writes;
        await writes;
      } while (!runtime.signal.aborted && writes !== project.writes);
      if (runtime.signal.aborted || read !== project.read) return;
      const revision = project.revision;
      try {
        const settings = await fetchSuggestedTasksSettings(projectId);
        if (runtime.signal.aborted || read !== project.read || revision !== project.revision) return;
        project.confirmed = settings;
        project.error = null;
      } catch (error) {
        if (runtime.signal.aborted || read !== project.read || revision !== project.revision) return;
        project.error = error instanceof Error ? error.message : String(error);
      }
      publish(projectId, project);
    },
    updateConfig: (projectId, update) => enqueue(projectId, {
      apply: (settings) => ({ ...settings, config: update(settings.config) }),
      write: (settings) => saveSuggestedTasksConfig(projectId, settings.config),
    }),
    setRepositoryLens: (projectId, file, enabled) => enqueue(projectId, {
      apply: (settings) => ({ ...settings, repoLenses: settings.repoLenses.map((lens) => lens.file === file ? { ...lens, status: enabled ? 'enabled' : 'disabled' } : lens) }),
      write: () => setRepositoryLensEnabled(projectId, file, enabled),
    }),
  };
});
