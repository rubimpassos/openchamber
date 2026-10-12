import type { GuestTooltipRequest } from '@openchamber/sdk';

export type GuestFrameTooltipState = {
  text: string;
  side: GuestTooltipRequest['side'];
  rect: { left: number; top: number; width: number; height: number };
};

/**
 * Where an extension's tooltip anchor sits on the page: the guest measures in
 * the frame's CSS pixels, and the frame may be zoomed by the interface scale.
 * `null` when the anchor is outside the visible frame.
 */
/** The parts of the frame element the placement reads. */
type FrameBox = {
  getBoundingClientRect: () => Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom' | 'width' | 'height'>;
  clientWidth: number;
  clientHeight: number;
};

export const placeGuestTooltip = (request: GuestTooltipRequest, frame: FrameBox): GuestFrameTooltipState | null => {
  const bounds = frame.getBoundingClientRect();
  if (frame.clientWidth <= 0 || frame.clientHeight <= 0) return null;
  const scaleX = bounds.width / frame.clientWidth;
  const scaleY = bounds.height / frame.clientHeight;
  const left = bounds.left + request.anchor.x * scaleX;
  const top = bounds.top + request.anchor.y * scaleY;
  const width = request.anchor.width * scaleX;
  const height = request.anchor.height * scaleY;
  if (left + width <= bounds.left || left >= bounds.right || top + height <= bounds.top || top >= bounds.bottom) return null;
  return { text: request.text, side: request.side, rect: { left, top, width, height } };
};
