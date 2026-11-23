let browserTabSequence = 0;

export const createBrowserTabDedupeKey = (kind: 'agent' | 'new'): string => {
  browserTabSequence += 1;
  return `browser:${kind}:${Date.now()}-${browserTabSequence}`;
};
