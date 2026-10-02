import React from 'react';
import { GUEST_MESSAGE_TEXT_SCAN_MAX, GUEST_TOOL_TEMPLATE_VALUE_MAX, type GuestMessageContribution } from '@openchamber/sdk';

import { isGuestActive } from './capabilities.ts';
import { useGuestsStore } from './store.ts';
import type { InstalledGuest } from './types.ts';

/** One `contributes.messages` entry of an active guest, compiled for matching. */
export type GuestMessageRule = GuestMessageContribution & {
  guestId: string;
  pattern: RegExp;
};

/** A user message a rule claimed: the rule, its rendered header, and the body text to show. */
export type GuestMessagePresentation = {
  rule: GuestMessageRule;
  title: string;
  subtitle: string | null;
  body: string;
};

const EMPTY_RULES: GuestMessageRule[] = [];

/**
 * The message rules of active guests, in catalog order. A pattern the parser
 * accepted always compiles; one that does not (an older catalog row) is
 * skipped instead of breaking the chat.
 */
export const compileGuestMessageRules = (guests: readonly InstalledGuest[]): GuestMessageRule[] => {
  const rules: GuestMessageRule[] = [];
  for (const guest of guests) {
    if (!isGuestActive(guest) || !guest.messages?.length) continue;
    for (const message of guest.messages) {
      let pattern: RegExp;
      try {
        pattern = new RegExp(message.match, 'm');
      } catch {
        continue;
      }
      rules.push({ ...message, guestId: guest.id, pattern });
    }
  }
  return rules.length > 0 ? rules : EMPTY_RULES;
};

const PLACEHOLDER = /\{match\.([A-Za-z0-9_]+)\}/g;

const capped = (text: string): string => (
  text.length > GUEST_TOOL_TEMPLATE_VALUE_MAX ? `${text.slice(0, GUEST_TOOL_TEMPLATE_VALUE_MAX - 1)}…` : text
);

/** `{match.name}` / `{match.1}` from a regex match; an unknown group is an empty string. */
export const renderMessageTemplate = (template: string, match: RegExpExecArray): string => (
  template.replace(PLACEHOLDER, (_whole, key: string) => {
    const value = /^\d+$/.test(key) ? match[Number(key)] : match.groups?.[key];
    return capped((value ?? '').replace(/\s+/g, ' ').trim());
  }).trim()
);

/**
 * The text a plugin message shows when expanded: without HTML comments (the
 * plugin's own markers) and without the `<system-reminder>` tags around it.
 */
export const guestMessageBodyText = (text: string): string => (
  text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?system-reminder>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
);

/** The first rule whose pattern matches `text`, rendered. `null` without a match. */
export const matchGuestMessageRule = (
  rules: readonly GuestMessageRule[],
  text: string,
): GuestMessagePresentation | null => {
  if (rules.length === 0 || !text) return null;
  const scanned = text.length > GUEST_MESSAGE_TEXT_SCAN_MAX ? text.slice(0, GUEST_MESSAGE_TEXT_SCAN_MAX) : text;
  for (const rule of rules) {
    const match = rule.pattern.exec(scanned);
    if (!match) continue;
    const title = rule.title ? renderMessageTemplate(rule.title, match) : '';
    const subtitle = rule.subtitle ? renderMessageTemplate(rule.subtitle, match) : '';
    return {
      rule,
      title: title || rule.name,
      subtitle: subtitle || null,
      body: guestMessageBodyText(text),
    };
  }
  return null;
};

let cachedGuests: readonly InstalledGuest[] | null = null;
let cachedRules: GuestMessageRule[] = EMPTY_RULES;

const rulesForCatalog = (guests: readonly InstalledGuest[]): GuestMessageRule[] => {
  if (guests !== cachedGuests) {
    cachedGuests = guests;
    cachedRules = compileGuestMessageRules(guests);
  }
  return cachedRules;
};

/** Text parts of a user message, joined the way the plugin sent them. */
export const userMessageText = (parts: readonly { type: string; text?: unknown; synthetic?: unknown }[]): string => (
  parts
    .flatMap((part) => (part.type === 'text' && typeof part.text === 'string' ? [part.text] : []))
    .join('\n')
);

/** The presentation of `text` under a catalog the caller already holds. Same memo as the hook. */
export const guestMessagePresentationIn = (guests: readonly InstalledGuest[], text: string): GuestMessagePresentation | null => (
  matchGuestMessageRule(rulesForCatalog(guests), text)
);

/**
 * The presentation of one user message, or `null` to keep the bubble.
 * Subscribes to the catalog array only. VS Code and mobile keep the store
 * empty, so this is always `null` there.
 */
export const useGuestMessagePresentation = (text: string | null): GuestMessagePresentation | null => {
  const guests = useGuestsStore((state) => state.guests);
  return React.useMemo(
    () => (text ? matchGuestMessageRule(rulesForCatalog(guests), text) : null),
    [guests, text],
  );
};
