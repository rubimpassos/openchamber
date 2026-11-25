type BrowserSessionAddress = {
  readonly guestId: string;
  readonly directory: string;
  readonly sessionId: string;
};

export const followsBrowserSession = (
  target: BrowserSessionAddress,
  shown: { readonly [Key in keyof BrowserSessionAddress]: string | null },
  following: boolean,
): boolean => following && target.guestId === shown.guestId
  && target.directory === shown.directory && target.sessionId === shown.sessionId;
