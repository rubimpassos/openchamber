export const GUEST_STATUS_SUMMARY_ITEMS_MAX = 4;
export const GUEST_STATUS_SUMMARY_TEXT_MAX = 16;
export const GUEST_STATUS_SUMMARY_LABEL_MAX = 60;
/** A Remixicon name, as in `panel.icon`; package SVG paths are not accepted here. */
export const GUEST_STATUS_SUMMARY_ICON = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const GUEST_STATUS_SUMMARY_TONES = ['muted', 'info', 'success', 'warning', 'error'] as const;

export type GuestStatusSummaryTone = typeof GUEST_STATUS_SUMMARY_TONES[number];

/**
 * One readout on a status section's header, beside the title, shown folded
 * and expanded alike. `text` is the value (`2/5`), `icon` names what it
 * counts, and `label` is the accessible name and tooltip (`2 of 5 todos done`).
 */
export type GuestStatusSummaryItem = {
  text: string;
  icon?: string;
  label?: string;
  tone?: GuestStatusSummaryTone;
};

const ITEM_KEYS = ['text', 'icon', 'label', 'tone'];

const isBoundedText = (value: string | undefined, max: number): boolean => (
  String(value) === value && value.length >= 1 && value.length <= max
);

/**
 * Guest-side fast-fail guard for `setStatusSummary`. The host zod schema is
 * still authoritative because JavaScript callers can bypass this SDK method.
 */
export const isGuestStatusSummary = (items: GuestStatusSummaryItem[]): boolean => {
  // The public type is precise, but this boundary also receives untyped JavaScript callers.
  if (!Array.isArray(items) || items.length > GUEST_STATUS_SUMMARY_ITEMS_MAX) return false;
  return items.every((item) => (
    Object(item) === item && !Array.isArray(item)
    && Object.keys(item).every((key) => ITEM_KEYS.includes(key))
    && isBoundedText(item.text, GUEST_STATUS_SUMMARY_TEXT_MAX)
    && (item.label === undefined || isBoundedText(item.label, GUEST_STATUS_SUMMARY_LABEL_MAX))
    && (item.icon === undefined || (String(item.icon) === item.icon && GUEST_STATUS_SUMMARY_ICON.test(item.icon)))
    && (item.tone === undefined || GUEST_STATUS_SUMMARY_TONES.some((tone) => tone === item.tone))
  ));
};
