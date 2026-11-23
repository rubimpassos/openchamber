export const isProviderNeedsYou = (cause: unknown): cause is { readonly state: 'needs-you' } =>
  cause !== null && (typeof cause === 'object' || typeof cause === 'function')
  && 'state' in cause && cause.state === 'needs-you';
