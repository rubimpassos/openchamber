import React from 'react';

import { useGuestDialogStore } from '@/lib/guests/dialog-store';
import { useGuestResolveHostStore } from '@/lib/guests/run-command';
import { useGuestActionHostStore } from '@/lib/guests/run-action';
import { pluginModeFromId } from '@/lib/surfaces/modes';
import { useAutomaticBackgrounds } from '@/lib/guests/automatic-backgrounds';

// Only explicitly automatic backgrounds load before an action or command.
const GuestAttachDialog = React.lazy(() => import('./GuestAttachDialog').then((module) => ({ default: module.GuestAttachDialog })));
const PluginPane = React.lazy(() => import('./PluginPane').then((module) => ({ default: module.PluginPane })));

/**
 * Frames that belong to no particular column: attach dialogs, temporary
 * background actions, and the hidden pane used by slash commands.
 */
export const GuestHosts: React.FC = () => {
  const dialogRequest = useGuestDialogStore((state) => state.request);
  const closeDialog = useGuestDialogStore((state) => state.close);
  const resolveGuestId = useGuestResolveHostStore((state) => state.guestId);
  const actionRequests = useGuestActionHostStore((state) => state.requests);
  const backgrounds = useAutomaticBackgrounds();

  return (
    <>
      {backgrounds.map((background) => (
        <div key={background.key} aria-hidden="true" inert className="pointer-events-none fixed top-0 -left-[9999px] h-px w-px overflow-hidden">
          <React.Suspense fallback={null}>
            <PluginPane mode={pluginModeFromId(background.guestId)} surface="background" headless />
          </React.Suspense>
        </div>
      ))}
      {actionRequests.map((request) => (
        <div key={request.id} aria-hidden="true" inert className="pointer-events-none fixed top-0 -left-[9999px] h-px w-px overflow-hidden">
          <React.Suspense fallback={null}>
            <PluginPane mode={pluginModeFromId(request.guestId)} surface="background" headless backgroundAction={request} />
          </React.Suspense>
        </div>
      ))}
      {dialogRequest ? (
        <React.Suspense fallback={null}>
          <GuestAttachDialog
            guestId={dialogRequest.guestId}
            item={dialogRequest.item}
            onOpenChange={(open) => {
              if (!open) closeDialog();
            }}
          />
        </React.Suspense>
      ) : null}
      {resolveGuestId ? (
        <div aria-hidden="true" className="pointer-events-none fixed top-0 -left-[9999px] h-px w-px overflow-hidden">
          <React.Suspense fallback={null}>
            <PluginPane mode={pluginModeFromId(resolveGuestId)} surface="panel" headless />
          </React.Suspense>
        </div>
      ) : null}
    </>
  );
};
