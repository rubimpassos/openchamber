import React from 'react';

import type { SurfaceInputEvent } from '@openchamber/sdk';

import { useI18n } from '@/lib/i18n';

import { routeTypingKey, typingStep } from './remoteTyping';

export type RemoteTypingHandle = {
  readonly toggle: () => void;
  readonly clear: () => void;
  readonly isOpen: () => boolean;
};

type RemoteTypingFieldProps = {
  pageEpoch: string;
  onType: (events: SurfaceInputEvent[]) => void;
  onKey: (action: 'down' | 'up', event: React.KeyboardEvent<HTMLElement>) => void;
  onOpenChange: (open: boolean) => void;
};

export const RemoteTypingField = React.forwardRef<RemoteTypingHandle, RemoteTypingFieldProps>(({ pageEpoch, onType, onKey, onOpenChange }, forwardedRef) => {
  const { t } = useI18n();
  const fieldRef = React.useRef<HTMLTextAreaElement | null>(null);
  const mirrorRef = React.useRef('');
  const mirroredEpochRef = React.useRef(pageEpoch);
  const composingRef = React.useRef(false);
  const keysHeldInPageRef = React.useRef(new Set<string>());

  const clear = React.useCallback(() => {
    mirrorRef.current = '';
    if (fieldRef.current) fieldRef.current.value = '';
  }, []);

  React.useImperativeHandle(forwardedRef, () => ({
    toggle: () => {
      const field = fieldRef.current;
      if (!field) return;
      if (document.activeElement === field) field.blur();
      else field.focus({ preventScroll: true });
    },
    clear,
    isOpen: () => fieldRef.current !== null && document.activeElement === fieldRef.current,
  }), [clear]);

  const onInput = (event: React.FormEvent<HTMLTextAreaElement>) => {
    const field = event.currentTarget;
    const step = typingStep(mirrorRef.current, field.value, {
      composing: composingRef.current,
      changed: mirroredEpochRef.current !== pageEpoch,
    });
    mirroredEpochRef.current = pageEpoch;
    mirrorRef.current = step.mirror;
    if (field.value !== step.mirror) field.value = step.mirror;
    if (step.events.length > 0) onType(step.events);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    event.stopPropagation();
    const route = routeTypingKey({
      key: event.key,
      keyCode: event.keyCode,
      composing: event.nativeEvent.isComposing || composingRef.current,
      chord: event.ctrlKey || event.metaKey,
      fieldEmpty: event.currentTarget.value === '',
    });
    if (route === 'field') return;
    if (route === 'page') clear();
    keysHeldInPageRef.current.add(event.code || event.key);
    onKey('down', event);
  };

  const onKeyUp = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    event.stopPropagation();
    if (keysHeldInPageRef.current.delete(event.code || event.key)) onKey('up', event);
  };

  return (
    <textarea
      ref={fieldRef}
      aria-label={t('contextPanel.browser.keyboard.fieldAria')}
      autoCapitalize="off"
      autoComplete="off"
      autoCorrect="off"
      spellCheck={false}
      rows={1}
      tabIndex={-1}
      className="pointer-events-none absolute bottom-0 inset-s-0 size-px resize-none border-0 p-0 text-[16px] opacity-0 outline-none"
      onInput={onInput}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onCompositionStart={() => { composingRef.current = true; }}
      onCompositionEnd={() => { composingRef.current = false; }}
      onFocus={() => onOpenChange(true)}
      onBlur={() => {
        clear();
        keysHeldInPageRef.current.clear();
        onOpenChange(false);
      }}
    />
  );
});
RemoteTypingField.displayName = 'RemoteTypingField';
