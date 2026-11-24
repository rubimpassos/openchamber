import { GUEST_MODEL_ID, GUEST_MODEL_PICK_LABEL_MAX, type ModelPickRequest, type ModelPickResult } from './model-picker.ts';
import { readGuestPopoverAnchor } from './popover-boundary.ts';

export const readModelPickRequest = (request: unknown): ModelPickRequest | null => {
  if (request === null || typeof request !== 'object' || !('anchor' in request) || !('value' in request)) return null;
  const anchor = readGuestPopoverAnchor(request.anchor);
  if (anchor === null || (request.value !== null && (typeof request.value !== 'string' || !GUEST_MODEL_ID.test(request.value)))) return null;
  let result: ModelPickRequest = { anchor, value: request.value };
  if ('none' in request && request.none !== undefined) {
    if (request.none === null || typeof request.none !== 'object' || !('label' in request.none)
      || typeof request.none.label !== 'string' || request.none.label.length < 1 || request.none.label.length > GUEST_MODEL_PICK_LABEL_MAX) return null;
    result = { ...result, none: { label: request.none.label } };
  }
  if ('recommended' in request && request.recommended !== undefined) {
    if (typeof request.recommended !== 'string' || !GUEST_MODEL_ID.test(request.recommended)) return null;
    result = { ...result, recommended: request.recommended };
  }
  return result;
};

export const readModelPickResult = (value: unknown): ModelPickResult | null => {
  if (value === null || typeof value !== 'object' || !('picked' in value)) return null;
  switch (value.picked) {
    case true:
      if (!('model' in value) || (value.model !== null && (typeof value.model !== 'string' || !GUEST_MODEL_ID.test(value.model)))) return null;
      return { picked: true, model: value.model };
    case false: return 'model' in value ? null : { picked: false };
    default: return null;
  }
};
