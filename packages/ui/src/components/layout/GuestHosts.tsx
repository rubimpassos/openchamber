import React from 'react';

import { useGuestDialogStore } from '@/lib/guests/dialog-store';
import { useGuestResolveHostStore } from '@/lib/guests/run-command';
import { useGuestActionHostStore } from '@/lib/guests/run-action';
import { pluginModeFromId } from '@/lib/surfaces/modes';
import { useAutomaticBackgrounds } from '@/lib/guests/automatic-backgrounds';
import { useGuestPlanFrameStore } from '@/lib/guests/plans/frames';

// Only explicitly automatic backgrounds load before an action or command.
const GuestAttachDialog = React.lazy(() => import('./GuestAttachDialog').then((module) => ({ default: module.GuestAttachDialog })));
const PluginPane = React.lazy(() => import('./PluginPane').then((module) => ({ default: module.PluginPane })));

/**
 * Frames that belong to no particular column: attach dialogs, temporary
 * background actions, the hidden pane used by slash commands, and the hidden
 * frames that describe extension plans for a worktree.
 */
export const GuestHosts: React.FC = () => {
  const dialogRequest = useGuestDialogStore((state) => state.request);
  const closeDialog = useGuestDialogStore((state) => state.close);
  const resolveGuestId = useGuestResolveHostStore((state) => state.guestId);
  const actionRequests = useGuestActionHostStore((state) => state.requests);
  const backgrounds = useAutomaticBackgrounds();
  const planFrames = useGuestPlanFrameStore((state) => state.frames);

  return (
    <>
      {backgrounds.map((background) => (
        <div key={background.key} aria-hidden="true" inert className="pointer-events-none fixed top-0 -inset-s-[9999px] h-px w-px overflow-hidden">
          <React.Suspense fallback={null}>
            <PluginPane mode={pluginModeFromId(background.guestId)} surface="background" headless />
          </React.Suspense>
        </div>
      ))}
      {Object.values(planFrames).map((frame) => (
        <div key={frame.key} aria-hidden="true" inert className="pointer-events-none fixed top-0 -inset-s-[9999px] h-px w-px overflow-hidden">
          <React.Suspense fallback={null}>
            <PluginPane mode={pluginModeFromId(frame.guestId)} surface="background" headless planHostDirectory={frame.directory} />
          </React.Suspense>
        </div>
      ))}
      {actionRequests.map((request) => (
        <div key={request.id} aria-hidden="true" inert className="pointer-events-none fixed top-0 -inset-s-[9999px] h-px w-px overflow-hidden">
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
        <div aria-hidden="true" className="pointer-events-none fixed top-0 -inset-s-[9999px] h-px w-px overflow-hidden">
          <React.Suspense fallback={null}>
            <PluginPane mode={pluginModeFromId(resolveGuestId)} surface="panel" headless />
          </React.Suspense>
        </div>
      ) : null}
    </>
  );
};
