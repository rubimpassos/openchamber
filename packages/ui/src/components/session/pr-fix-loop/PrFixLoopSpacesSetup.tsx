import { IsolatedSpacesSettings } from '@/components/sections/openchamber/IsolatedSpacesSettings';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';

/** The existing opt-in and place funnel, reachable without releasing the global Spaces page. */
export function PrFixLoopSpacesSetup({ open, onClose }: { readonly open: boolean; readonly onClose: () => void }) {
  const { t } = useI18n();
  const mobile = useUIStore((state) => state.isMobile);
  const title = t('prFixLoop.worker.setup');
  const footer = <Button variant="outline" size="sm" onClick={onClose}>{t('dialog.common.actions.close')}</Button>;
  if (mobile) return <MobileOverlayPanel open={open} title={title} onClose={onClose} footer={footer}>
    <div className="@container"><IsolatedSpacesSettings /></div>
  </MobileOverlayPanel>;
  return <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
    {open ? <DialogContent className="max-h-[85dvh] overflow-hidden">
      <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
      <SettingsPageLayout outerClassName="min-h-0 flex-1" showSaveStatus><IsolatedSpacesSettings /></SettingsPageLayout>
      <DialogFooter>{footer}</DialogFooter>
    </DialogContent> : null}
  </Dialog>;
}
