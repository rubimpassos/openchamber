import * as React from 'react';

import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Icon } from '@/components/icon/Icon';
import {
  SettingsSection,
  SETTINGS_CALLOUT_TITLE_CLASS,
  SETTINGS_HELPER_CLASS,
  SETTINGS_SELECT_SIZE,
} from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { formatDateTimeForPreference } from '@/lib/timeFormat';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useServerBrowserSignIn } from '@/lib/browser/serverBrowser/panelTabs';
import type { ProjectEntry } from '@/lib/api/types';
import {
  bindProfile,
  clearProfileSite,
  closeProfile,
  createProfile,
  deleteProfile,
  getBrowserState,
  getProfileSites,
  isDockAccessError,
  isServerBrowserUnavailable,
  isStaleProfileError,
  listProfiles,
  openProfile,
  renameProfile,
  revokeAllProfiles,
  unbindProfile,
  type BrowserProfile,
  type ProfileSite,
} from './serverBrowserApi';

const REVOKE_PHRASE = 'REVOKE';

type BusyNotice = { kind: 'chat' | 'signIn'; name?: string };

const projectLabel = (project: ProjectEntry): string => project.label || project.path;

export const BrowserProfilesSection: React.FC = () => {
  const { t } = useI18n();
  const projects = useProjectsStore((state) => state.projects);

  const [profiles, setProfiles] = React.useState<BrowserProfile[] | null>(null);
  const [unavailable, setUnavailable] = React.useState(false);
  const [newName, setNewName] = React.useState('');
  const [creating, setCreating] = React.useState(false);
  const [sitesFor, setSitesFor] = React.useState<BrowserProfile | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<BrowserProfile | null>(null);
  const [busyNotice, setBusyNotice] = React.useState<BusyNotice | null>(null);
  const [revokeOpen, setRevokeOpen] = React.useState(false);

  const refresh = React.useCallback(async () => {
    const result = await listProfiles();
    if (!result.ok) {
      if (isServerBrowserUnavailable(result)) {
        setUnavailable(true);
        setProfiles([]);
        return;
      }
      toast.error(t('settings.browser.profiles.loadFailed'));
      return;
    }
    setUnavailable(false);
    setProfiles(result.value.profiles);
  }, [t]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleCreate = React.useCallback(async () => {
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    const result = await createProfile(name);
    setCreating(false);
    if (!result.ok) {
      toast.error(t('settings.browser.profiles.create.toast.failed'));
      return;
    }
    setNewName('');
    setProfiles(result.value.profiles);
    toast.success(t('settings.browser.profiles.create.toast.success', { name }));
  }, [creating, newName, t]);

  const handleRename = React.useCallback(async (profile: BrowserProfile, name: string) => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === profile.name) return;
    const result = await renameProfile(profile.id, trimmed);
    if (!result.ok) {
      toast.error(t('settings.browser.profiles.rename.toast.failed'));
      return;
    }
    setProfiles(result.value.profiles);
    toast.success(t('settings.browser.profiles.rename.toast.success', { name: trimmed }));
  }, [t]);

  const handleBind = React.useCallback(async (profile: BrowserProfile, project: ProjectEntry) => {
    const result = await bindProfile(profile.id, project.path);
    if (!result.ok) {
      toast.error(t('settings.browser.profiles.projects.bind.toast.failed'));
      return;
    }
    setProfiles(result.value.profiles);
    toast.success(t('settings.browser.profiles.projects.bind.toast.success', {
      project: projectLabel(project),
      name: profile.name,
    }));
  }, [t]);

  const handleUnbind = React.useCallback(async (profile: BrowserProfile, directory: string) => {
    const label = projects.find((entry) => entry.path === directory)?.label || directory;
    const result = await unbindProfile(profile.id, directory);
    if (!result.ok) {
      toast.error(t('settings.browser.profiles.projects.unbind.toast.failed'));
      return;
    }
    setProfiles(result.value.profiles);
    toast.success(t('settings.browser.profiles.projects.unbind.toast.success', { project: label }));
  }, [projects, t]);

  const handleSignIn = React.useCallback(async (profile: BrowserProfile) => {
    const state = await getBrowserState();
    if (!state.ok) {
      toast.error(t('settings.browser.profiles.signIn.toast.failed'));
      return;
    }
    const result = await openProfile(profile.id, state.value.generation);
    if (!result.ok) {
      if (result.kind === 'http' && isDockAccessError(result.message)) {
        const holder = state.value.scopes.find((scope) => scope.id === state.value.selectedScopeId);
        setBusyNotice(holder?.signIn
          ? { kind: 'signIn', name: holder.profile?.name }
          : { kind: 'chat' });
        return;
      }
      toast.error(t('settings.browser.profiles.signIn.toast.failed'));
      return;
    }
    setBusyNotice(null);
    setProfiles(result.value.profiles);
    // Take the person to the page they sign in on: the Browser panel, showing
    // this profile's sign-in browser with a bar to save it.
    const activeProjectId = useProjectsStore.getState().activeProjectId;
    const directory = useDirectoryStore.getState().currentDirectory
      || projects.find((entry) => entry.id === activeProjectId)?.path
      || projects[0]?.path;
    useServerBrowserSignIn.getState().setSignIn({ profileId: profile.id, name: profile.name });
    if (directory) {
      useUIStore.getState().openContextBrowser(directory);
      useUIStore.getState().setSettingsDialogOpen(false);
    }
  }, [projects, t]);

  const handleSave = React.useCallback(async (profile: BrowserProfile) => {
    const result = await closeProfile(profile.id);
    if (!result.ok) {
      if (result.kind === 'http' && isStaleProfileError(result.message)) {
        toast.error(t('settings.browser.profiles.save.toast.stale'));
        return;
      }
      toast.error(t('settings.browser.profiles.save.toast.failed'));
      return;
    }
    setProfiles(result.value.profiles);
    if (useServerBrowserSignIn.getState().signIn?.profileId === profile.id) useServerBrowserSignIn.getState().setSignIn(null);
    toast.success(t('settings.browser.profiles.save.toast.success', { name: profile.name }));
  }, [t]);

  const handleDelete = React.useCallback(async () => {
    if (!deleteTarget) return;
    const result = await deleteProfile(deleteTarget.id);
    if (!result.ok) {
      toast.error(t('settings.browser.profiles.delete.toast.failed'));
      return;
    }
    setProfiles(result.value.profiles);
    toast.success(t('settings.browser.profiles.delete.toast.success', { name: deleteTarget.name }));
    setDeleteTarget(null);
  }, [deleteTarget, t]);

  const handleRevokeAll = React.useCallback(async () => {
    const result = await revokeAllProfiles();
    if (!result.ok) {
      toast.error(t('settings.browser.profiles.revokeAll.toast.failed'));
      return;
    }
    setProfiles(result.value.profiles);
    toast.success(t('settings.browser.profiles.revokeAll.toast.success'));
    setRevokeOpen(false);
  }, [t]);

  const loading = profiles === null;

  return (
    <SettingsSection
      title={t('settings.browser.profiles.title')}
      description={t('settings.browser.profiles.description')}
      settingsItem="browser.profiles"
      headerAction={!unavailable && !loading && profiles.length > 0 ? (
        <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setRevokeOpen(true)}>
          {t('settings.browser.profiles.revokeAll.action')}
        </Button>
      ) : null}
    >
      {unavailable ? (
        <p className={SETTINGS_HELPER_CLASS}>{t('settings.browser.profiles.unavailable')}</p>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Input
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void handleCreate();
              }}
              placeholder={t('settings.browser.profiles.create.placeholder')}
              aria-label={t('settings.browser.profiles.create.aria')}
              className="max-w-[16rem]"
            />
            <Button size="sm" variant="outline" disabled={!newName.trim() || creating} onClick={() => void handleCreate()}>
              <Icon name="add" className="h-3.5 w-3.5" />
              {t('settings.common.actions.create')}
            </Button>
          </div>

          {busyNotice ? (
            <div className="flex items-start gap-2 rounded-lg border border-[var(--status-warning)]/30 bg-[var(--status-warning)]/5 p-3">
              <Icon name="error-warning" className="mt-0.5 size-4 shrink-0 text-[var(--status-warning)]" />
              <div className="flex-1 space-y-2">
                <p className={SETTINGS_CALLOUT_TITLE_CLASS}>{t('settings.browser.profiles.signIn.busy.title')}</p>
                <p className={SETTINGS_HELPER_CLASS}>
                  {busyNotice.kind === 'signIn'
                    ? t('settings.browser.profiles.signIn.busy.signIn', { name: busyNotice.name ?? '' })
                    : t('settings.browser.profiles.signIn.busy.chat')}
                </p>
                <Button size="xs" variant="outline" onClick={() => setBusyNotice(null)}>
                  {t('settings.browser.profiles.signIn.busy.retry')}
                </Button>
              </div>
            </div>
          ) : null}

          {loading ? (
            <div className="flex items-center justify-center py-8">
              <span className="h-1.5 w-1.5 rounded-full bg-current animate-busy-pulse" />
            </div>
          ) : profiles.length === 0 ? (
            <div className="py-6 text-center text-muted-foreground">
              <Icon name="shield-keyhole" className="mx-auto mb-2 h-8 w-8 opacity-40" />
              <p className="typography-ui-label">{t('settings.browser.profiles.empty.title')}</p>
              <p className="typography-meta mt-1 opacity-75">{t('settings.browser.profiles.empty.description')}</p>
            </div>
          ) : (
            <div className="rounded-lg bg-[var(--surface-elevated)]/70 overflow-hidden flex flex-col">
              {profiles.map((profile, index) => (
                <ProfileRow
                  key={profile.id}
                  profile={profile}
                  projects={projects}
                  hasBorder={index < profiles.length - 1}
                  onRename={(name) => handleRename(profile, name)}
                  onBind={(project) => handleBind(profile, project)}
                  onUnbind={(directory) => handleUnbind(profile, directory)}
                  onSignIn={() => handleSignIn(profile)}
                  onSave={() => handleSave(profile)}
                  onShowSites={() => setSitesFor(profile)}
                  onDelete={() => setDeleteTarget(profile)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      <ProfileSitesDialog profile={sitesFor} onOpenChange={(open) => { if (!open) setSitesFor(null); }} />

      <Dialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.browser.profiles.delete.confirm.title', { name: deleteTarget?.name ?? '' })}</DialogTitle>
            <DialogDescription>{t('settings.browser.profiles.delete.confirm.description')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>{t('settings.common.actions.cancel')}</Button>
            <Button size="sm" variant="destructive" onClick={() => void handleDelete()}>{t('settings.common.actions.delete')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <RevokeAllDialog open={revokeOpen} onOpenChange={setRevokeOpen} onConfirm={() => void handleRevokeAll()} />
    </SettingsSection>
  );
};

interface ProfileRowProps {
  profile: BrowserProfile;
  projects: ProjectEntry[];
  hasBorder: boolean;
  onRename: (name: string) => void;
  onBind: (project: ProjectEntry) => void;
  onUnbind: (directory: string) => void;
  onSignIn: () => void;
  onSave: () => void;
  onShowSites: () => void;
  onDelete: () => void;
}

const ProfileRow: React.FC<ProfileRowProps> = ({
  profile,
  projects,
  hasBorder,
  onRename,
  onBind,
  onUnbind,
  onSignIn,
  onSave,
  onShowSites,
  onDelete,
}) => {
  const { t } = useI18n();
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
  const [isRenaming, setIsRenaming] = React.useState(false);
  const [draft, setDraft] = React.useState(profile.name);

  React.useEffect(() => {
    if (!isRenaming) setDraft(profile.name);
  }, [isRenaming, profile.name]);

  const commitRename = () => {
    setIsRenaming(false);
    onRename(draft);
  };

  const boundProjects = profile.projects.map((directory) => ({
    directory,
    label: projects.find((entry) => entry.path === directory)?.label || directory,
  }));
  const bindableProjects = projects.filter((project) => !profile.projects.includes(project.path));

  const chatCount = profile.chats.length;
  const chatsLabel = chatCount === 0
    ? t('settings.browser.profiles.chats.none')
    : chatCount === 1
      ? t('settings.browser.profiles.chats.one')
      : t('settings.browser.profiles.chats.many', { count: chatCount });

  const savedLabel = profile.version > 0
    ? t('settings.browser.profiles.saved.count', { count: profile.version })
    : t('settings.browser.profiles.saved.never');

  const lastUsedLabel = profile.lastUsedAt
    ? t('settings.browser.profiles.lastUsed.label', {
      time: formatDateTimeForPreference(profile.lastUsedAt, timeFormatPreference, {
        dateStyle: 'medium',
        timeStyle: 'short',
      } as Intl.DateTimeFormatOptions),
    })
    : t('settings.browser.profiles.lastUsed.never');

  return (
    <div className={cn('flex flex-col gap-2 px-4 py-3', hasBorder && 'border-b border-[var(--surface-subtle)]')}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          {isRenaming ? (
            <Input
              value={draft}
              autoFocus
              onChange={(event) => setDraft(event.target.value)}
              onBlur={commitRename}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitRename();
                if (event.key === 'Escape') { setDraft(profile.name); setIsRenaming(false); }
              }}
              aria-label={t('settings.browser.profiles.rename.aria', { name: profile.name })}
              className="h-7 max-w-[16rem]"
            />
          ) : (
            <button
              type="button"
              onClick={() => setIsRenaming(true)}
              className="flex min-w-0 items-center gap-1.5 rounded typography-ui-label font-medium text-foreground hover:text-foreground/80"
            >
              <span className="truncate">{profile.name}</span>
              {profile.signingIn ? (
                <span className="shrink-0 typography-micro px-1 rounded leading-none pb-px text-[var(--status-warning)] bg-[var(--status-warning)]/10">
                  {t('settings.browser.profiles.badge.signingIn')}
                </span>
              ) : null}
            </button>
          )}
          <div className="typography-micro text-muted-foreground/70 mt-0.5">
            {savedLabel} · {lastUsedLabel} · {chatsLabel}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {profile.signingIn ? (
            <Button size="sm" variant="outline" onClick={onSave}>
              {t('settings.browser.profiles.save.action')}
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={onSignIn} aria-label={t('settings.browser.profiles.signIn.aria', { name: profile.name })}>
              {t('settings.browser.profiles.signIn.action')}
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="ghost" className="h-7 w-7">
                <Icon name="more-2" className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-fit min-w-32">
              <DropdownMenuItem onClick={onShowSites}>
                {t('settings.browser.profiles.sites.action')}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={onDelete}
                className="text-destructive focus:text-destructive"
              >
                <Icon name="delete-bin" className="h-4 w-4 mr-px" />
                {t('settings.common.actions.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {boundProjects.length === 0 ? (
          <span className="typography-micro text-muted-foreground/60">{t('settings.browser.profiles.projects.none')}</span>
        ) : boundProjects.map((entry) => (
          <span
            key={entry.directory}
            className="inline-flex items-center gap-1 rounded border border-border/50 bg-muted px-1.5 py-0.5 typography-micro text-muted-foreground"
          >
            {entry.label}
            <button
              type="button"
              onClick={() => onUnbind(entry.directory)}
              aria-label={t('settings.browser.profiles.projects.unbind.aria', { project: entry.label })}
              className="text-muted-foreground/70 hover:text-foreground"
            >
              <Icon name="close" className="h-3 w-3" />
            </button>
          </span>
        ))}
        {bindableProjects.length > 0 ? (
          <Select<string>
            value=""
            onValueChange={(projectId) => {
              const project = bindableProjects.find((entry) => entry.id === projectId);
              if (project) onBind(project);
            }}
          >
            <SelectTrigger
              size={SETTINGS_SELECT_SIZE}
              className="h-6 min-h-0 w-fit max-w-[14ch] border-dashed px-1.5 typography-micro"
              aria-label={t('settings.browser.profiles.projects.bind.aria', { name: profile.name })}
            >
              <SelectValue>{() => t('settings.browser.profiles.projects.bind.placeholder')}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {bindableProjects.map((project) => (
                <SelectItem key={project.id} value={project.id}>{projectLabel(project)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </div>
    </div>
  );
};

const ProfileSitesDialog: React.FC<{ profile: BrowserProfile | null; onOpenChange: (open: boolean) => void }> = ({ profile, onOpenChange }) => {
  const { t } = useI18n();
  const [sites, setSites] = React.useState<ProfileSite[] | null>(null);

  React.useEffect(() => {
    if (!profile) {
      setSites(null);
      return;
    }
    setSites(null);
    void getProfileSites(profile.id).then((result) => {
      if (!result.ok) {
        toast.error(t('settings.browser.profiles.sites.loadFailed'));
        setSites([]);
        return;
      }
      setSites(result.value.sites);
    });
  }, [profile, t]);

  const handleRemove = async (domain: string) => {
    if (!profile) return;
    const result = await clearProfileSite(profile.id, domain);
    if (!result.ok) {
      toast.error(t('settings.browser.profiles.sites.remove.toast.failed'));
      return;
    }
    setSites(result.value.sites);
    toast.success(t('settings.browser.profiles.sites.remove.toast.success', { domain }));
  };

  return (
    <Dialog open={profile !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('settings.browser.profiles.sites.title')}</DialogTitle>
          <DialogDescription>{t('settings.browser.profiles.sites.description')}</DialogDescription>
        </DialogHeader>
        <div className="max-h-80 space-y-1 overflow-y-auto">
          {sites === null ? (
            <div className="flex items-center justify-center py-6">
              <span className="h-1.5 w-1.5 rounded-full bg-current animate-busy-pulse" />
            </div>
          ) : sites.length === 0 ? (
            <p className={SETTINGS_HELPER_CLASS}>{t('settings.browser.profiles.sites.empty')}</p>
          ) : sites.map((site) => (
            <div key={site.domain} className="flex items-center justify-between gap-2 rounded px-2 py-1.5 hover:bg-interactive-hover/30">
              <span className="typography-ui-label truncate">{site.domain}</span>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => void handleRemove(site.domain)}
                aria-label={t('settings.browser.profiles.sites.remove.aria', { domain: site.domain })}
              >
                {t('settings.browser.profiles.sites.remove')}
              </Button>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>{t('settings.browser.profiles.sites.close')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

const RevokeAllDialog: React.FC<{ open: boolean; onOpenChange: (open: boolean) => void; onConfirm: () => void }> = ({ open, onOpenChange, onConfirm }) => {
  const { t } = useI18n();
  const [value, setValue] = React.useState('');

  React.useEffect(() => {
    if (!open) setValue('');
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('settings.browser.profiles.revokeAll.confirm.title')}</DialogTitle>
          <DialogDescription>{t('settings.browser.profiles.revokeAll.confirm.description')}</DialogDescription>
        </DialogHeader>
        <Input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={t('settings.browser.profiles.revokeAll.confirm.placeholder')}
          aria-label={t('settings.browser.profiles.revokeAll.confirm.placeholder')}
        />
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>{t('settings.common.actions.cancel')}</Button>
          <Button size="sm" variant="destructive" disabled={value !== REVOKE_PHRASE} onClick={onConfirm}>
            {t('settings.browser.profiles.revokeAll.confirm.action')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
