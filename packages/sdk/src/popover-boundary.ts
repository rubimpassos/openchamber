import { GUEST_POPOVER_COORDINATE_MAX, type GuestPopoverAnchor } from './popover.ts';

export const readGuestPopoverAnchor = (anchor: unknown): GuestPopoverAnchor | null => {
  if (anchor === null || typeof anchor !== 'object'
    || !('x' in anchor) || typeof anchor.x !== 'number'
    || !('y' in anchor) || typeof anchor.y !== 'number'
    || !('width' in anchor) || typeof anchor.width !== 'number'
    || !('height' in anchor) || typeof anchor.height !== 'number'
    || !Number.isFinite(anchor.x) || Math.abs(anchor.x) > GUEST_POPOVER_COORDINATE_MAX
    || !Number.isFinite(anchor.y) || Math.abs(anchor.y) > GUEST_POPOVER_COORDINATE_MAX
    || !Number.isFinite(anchor.width) || anchor.width <= 0 || anchor.width > GUEST_POPOVER_COORDINATE_MAX
    || !Number.isFinite(anchor.height) || anchor.height <= 0 || anchor.height > GUEST_POPOVER_COORDINATE_MAX) return null;
  return { x: anchor.x, y: anchor.y, width: anchor.width, height: anchor.height };
};
