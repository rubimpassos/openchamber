export const createTab = (targetId, sessionId, openerId) => ({
  targetId,
  sessionId,
  openerId,
  mainFrameId: targetId,
  url: 'about:blank',
  title: '',
  isLoading: false,
  canGoBack: false,
  canGoForward: false,
  navigationRefresh: null,
  navigationStale: false,
  navigationTimer: null,
  problems: [],
  compatibility: null,
  lastActive: 0,
  openedByAgent: false,
  dialog: null,
  fileChooser: null,
  dialogListeners: new Set(),
  staleSettings: new Set(),
});

export const isScopePage = (info, contextId, ignoredTargetId = null) => info?.type === 'page'
  && info.browserContextId === contextId
  && info.targetId !== ignoredTargetId
  && info.subtype !== 'prerender';

export const untilDialog = (current, promise) => new Promise((resolve, reject) => {
  const onChange = () => {
    if (!current.dialog) return;
    current.dialogListeners.delete(onChange);
    resolve(null);
  };
  current.dialogListeners.add(onChange);
  onChange();
  promise.then((value) => {
    current.dialogListeners.delete(onChange);
    resolve(value);
  }, (error) => {
    current.dialogListeners.delete(onChange);
    reject(error);
  });
});

export const requireNoDialog = (current) => {
  if (current?.dialog) throw new Error('Answer the dialog on this page first');
};

export const requireTab = (tabs, tabId) => {
  const current = tabs.get(tabId);
  if (!current) throw new Error('That tab is no longer open');
  return current;
};
