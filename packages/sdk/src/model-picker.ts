import type { GuestPopoverAnchor } from './popover.ts';
import { readModelPickRequest, readModelPickResult } from './model-picker-boundary.ts';
import { OPENCHAMBER_SDK_API_VERSION, OPENCHAMBER_SDK_CHANNEL } from './api-version.ts';
import { HostRequestError } from './host-errors.ts';
import type { GuestMessage, HostReadyContext, HostResultPayload } from './contract.ts';

export type GuestModelCatalog = readonly {
  readonly id: string;
  readonly name: string;
  readonly provider?: string;
  readonly variants: readonly string[];
}[];

export const GUEST_MODEL_ID = /^[^/\s]+\/[^\s]+$/;
export const GUEST_MODEL_PICK_LABEL_MAX = 120;
const GUEST_MODEL_PICK_TIMEOUT_MS = 30 * 60_000;
const GUEST_OPENCODE_RESTART_TIMEOUT_MS = 2 * 60_000;

export type ModelPickRequest = {
  readonly anchor: GuestPopoverAnchor;
  readonly value: string | null;
  readonly none?: { readonly label: string };
  readonly recommended?: string;
};
export type ModelPickResult =
  | { readonly picked: true; readonly model: string | null }
  | { readonly picked: false };

export type ModelPickerClient = {
  pickModel: (request: ModelPickRequest) => Promise<ModelPickResult>;
  restartOpenCode: () => Promise<void>;
};

export const guestModelPickerCalls = (
  send: (message: Extract<GuestMessage, { type: 'model-pick' | 'opencode-restart' }>, timeoutMs: number) => Promise<HostResultPayload | undefined>,
  nextId: () => string,
  getFeatures: () => HostReadyContext['features'],
): ModelPickerClient => {
  const envelope: Pick<GuestMessage, 'channel' | 'v'> = { channel: OPENCHAMBER_SDK_CHANNEL, v: OPENCHAMBER_SDK_API_VERSION };
  return {
    pickModel: async (payload) => {
      if (getFeatures()?.modelPicker !== true) {
        throw new HostRequestError('UNSUPPORTED', 'This host does not support a model picker.');
      }
      const request = readModelPickRequest(payload);
      if (request === null) {
        throw new HostRequestError('HOST_REJECTED', 'Model picker requests need a bounded anchor, provider/model IDs and a label of 1 to 120 characters.');
      }
      const result = readModelPickResult(await send({ ...envelope, type: 'model-pick', id: nextId(), payload: request }, GUEST_MODEL_PICK_TIMEOUT_MS));
      if (result === null) throw new HostRequestError('HOST_REJECTED', 'Host returned an invalid model selection.');
      return result;
    },
    restartOpenCode: () => {
      if (getFeatures()?.restartOpenCode !== true) {
        return Promise.reject(new HostRequestError('UNSUPPORTED', 'This host does not support restarting OpenCode.'));
      }
      return send({ ...envelope, type: 'opencode-restart', id: nextId(), payload: {} }, GUEST_OPENCODE_RESTART_TIMEOUT_MS).then(() => undefined);
    },
  };
};
