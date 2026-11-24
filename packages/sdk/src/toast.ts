import { OPENCHAMBER_SDK_API_VERSION, OPENCHAMBER_SDK_CHANNEL } from './api-version.ts';
import { GUEST_CLIPBOARD_TEXT_MAX, GUEST_TOAST_MAX, type GuestToastMessage } from './contract.ts';
import { HostRequestError } from './host-errors.ts';

export type ToastKind = 'info' | 'success' | 'error';

export type ToastRequest = {
  kind: ToastKind;
  message: string;
  copy?: boolean | { text: string };
  dismiss?: boolean;
  persistent?: boolean;
  action?: 'restart-opencode';
};

export type GuestToastClient = {
  toast: (request: ToastRequest) => Promise<void>;
};

export const guestToastCalls = (
  request: (message: GuestToastMessage) => Promise<void>,
  nextId: () => string,
): GuestToastClient => ({
  toast: (payload) => {
    if (payload.action !== undefined && payload.action !== 'restart-opencode') {
      return Promise.reject(new HostRequestError('HOST_REJECTED', 'Unknown toast action.'));
    }
    const message = payload.message.trim();
    if (!message || message.length > GUEST_TOAST_MAX) {
      return Promise.reject(new HostRequestError('HOST_REJECTED', `Toast message must contain 1 to ${GUEST_TOAST_MAX} characters.`));
    }
    if (payload.copy && payload.copy !== true && (!payload.copy.text.length || payload.copy.text.length > GUEST_CLIPBOARD_TEXT_MAX)) {
      return Promise.reject(new HostRequestError('HOST_REJECTED', `Toast copy text must contain 1 to ${GUEST_CLIPBOARD_TEXT_MAX} characters.`));
    }
    return request({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'toast',
      id: nextId(),
      payload: { ...payload, message },
    });
  },
});
