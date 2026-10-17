import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { isSessionPriority } from '@/lib/sessionPriority';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { setSessionPriority } from '@/sync/session-actions';
import { SessionMenuItemHint } from './SessionMenuItemHint';

/** Marks a top-level session as a priority or clears it. Mounted in the sidebar row menu and the session header menu. */
export function SessionPriorityMenuItem({ sessionID, directory, Item }: {
  sessionID: string;
  directory: string | null | undefined;
  Item: React.ElementType;
}) {
  const { t } = useI18n();
  const priority = useGlobalSessionsStore((state) => isSessionPriority(state.entityById.get(sessionID)));

  const toggle = () => {
    setSessionPriority(sessionID, directory, !priority).catch(() => {
      toast.error(t('sessions.sidebar.session.priority.updateFailed'));
    });
  };

  return (
    <SessionMenuItemHint hint={priority ? t('sessions.sidebar.session.menuHint.priorityOff') : t('sessions.sidebar.session.menuHint.priorityOn')}>
      <Item onClick={toggle} className="[&>svg]:me-1">
        <Icon name="flag" className="me-1 size-4" />
        {priority ? t('sessions.sidebar.session.menu.priorityOff') : t('sessions.sidebar.session.menu.priorityOn')}
      </Item>
    </SessionMenuItemHint>
  );
}
