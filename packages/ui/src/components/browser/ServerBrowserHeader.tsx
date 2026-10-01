import React from 'react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n, type I18nKey, type I18nParams } from '@/lib/i18n';
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { cn } from '@/lib/utils';

import type { ServerBrowserScope } from '@/lib/browser/serverBrowser/types';

/** `scope.directory` for a profile sign-in browser, set by the service, never a real path. */
const SIGN_IN_PREFIX = 'profile:';

const useSessionTitle = (sessionId: string | null): string | null => {
  const sessionsByDirectory = useGlobalSessionsStore((state) => state.sessionsByDirectory);
  return React.useMemo(() => {
    if (!sessionId) return null;
    for (const sessions of sessionsByDirectory.values()) {
      const found = sessions.find((session) => session.id === sessionId);
      if (found) return found.title?.trim() || null;
    }
    return null;
  }, [sessionId, sessionsByDirectory]);
};

const scopeLabel = (scope: ServerBrowserScope, title: string | null, t: (key: I18nKey, values?: I18nParams) => string): string => {
  if (scope.directory.startsWith(SIGN_IN_PREFIX)) {
    return t('contextPanel.browser.server.signingIn', { profile: scope.profile?.name ?? scope.directory.slice(SIGN_IN_PREFIX.length) });
  }
  return title || t('contextPanel.browser.server.untitledChat');
};

export const ServerBrowserHeader: React.FC<{
  scope: ServerBrowserScope | null;
  allScopes: readonly ServerBrowserScope[];
  onSelectScope: (scopeId: string) => void;
  onCloseScope: (scopeId: string) => void;
}> = ({ scope, allScopes, onSelectScope, onCloseScope }) => {
  const { t } = useI18n();
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  const sessionsByDirectory = useGlobalSessionsStore((state) => state.sessionsByDirectory);
  const title = useSessionTitle(scope?.sessionId ?? null);
  const isSignIn = scope ? scope.directory.startsWith(SIGN_IN_PREFIX) : false;

  const openChat = React.useCallback(() => {
    if (!scope?.sessionId) return;
    let directory: string | null = null;
    for (const [dir, sessions] of sessionsByDirectory) {
      if (sessions.some((session) => session.id === scope.sessionId)) { directory = dir; break; }
    }
    if (!directory) {
      for (const sessions of sessionsByDirectory.values()) {
        const found = sessions.find((session) => session.id === scope.sessionId);
        if (found) { directory = resolveGlobalSessionDirectory(found); break; }
      }
    }
    setCurrentSession(scope.sessionId, directory);
  }, [scope, sessionsByDirectory, setCurrentSession]);

  const otherScopes = allScopes.filter((entry) => entry.id !== scope?.id);
  const othersOnProfile = scope?.profile
    ? Math.max(0, scope.profile.users - 1)
    : 0;

  return (
    <div className="flex items-center gap-1.5 border-b border-border bg-[var(--surface-background)] px-2 py-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={openChat}
            disabled={!scope?.sessionId}
            className="typography-meta min-w-0 max-w-[40%] shrink truncate text-left text-foreground hover:underline disabled:no-underline"
          >
            {scope ? scopeLabel(scope, title, t) : t('contextPanel.browser.server.untitledChat')}
          </button>
        </TooltipTrigger>
        <TooltipContent sideOffset={6}>{t('contextPanel.browser.server.openChat')}</TooltipContent>
      </Tooltip>

      {scope?.profile ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="typography-micro shrink-0 truncate rounded-full bg-[var(--surface-muted)] px-2 py-0.5 text-muted-foreground">
              {t('contextPanel.browser.server.profileCopy', {
                name: scope.profile.name,
                version: scope.profile.copyVersion ?? 1,
              })}
            </span>
          </TooltipTrigger>
          {othersOnProfile > 0 ? (
            <TooltipContent sideOffset={6}>
              {t('contextPanel.browser.server.profileOthers', { count: othersOnProfile })}
            </TooltipContent>
          ) : null}
        </Tooltip>
      ) : null}

      <div className="ml-auto flex shrink-0 items-center gap-1">
        {isSignIn ? null : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="w-6 shrink-0 rounded-full px-0 text-muted-foreground hover:text-foreground"
                aria-label={t('contextPanel.browser.server.switchChat')}
              >
                <Icon name="arrow-left-right" className="size-3.5" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              {otherScopes.length === 0 ? (
                <div className="px-2 py-3 text-center typography-meta text-muted-foreground">
                  {t('contextPanel.browser.server.switchChatEmpty')}
                </div>
              ) : (
                otherScopes.map((entry) => (
                  <DropdownMenuItem key={entry.id} onClick={() => onSelectScope(entry.id)}>
                    <span className="truncate">{scopeLabel(entry, null, t)}</span>
                  </DropdownMenuItem>
                ))
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        {scope && !isSignIn ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className={cn('w-6 shrink-0 rounded-full px-0 text-muted-foreground', 'hover:text-foreground')}
                onClick={() => onCloseScope(scope.id)}
                aria-label={t('contextPanel.browser.server.closeScope')}
              >
                <Icon name="close" className="size-3.5" aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent sideOffset={6}>{t('contextPanel.browser.server.closeScope')}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
    </div>
  );
};
