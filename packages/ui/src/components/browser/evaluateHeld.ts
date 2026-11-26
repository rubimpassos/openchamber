const HELD_POLL_MS = 8_000;
let heldSequence = 0;

export const evaluateHeld = async (
  evaluate: (expression: string, userGesture?: boolean) => Promise<unknown>,
  code: string,
  userGesture?: boolean,
): Promise<unknown> => {
  heldSequence += 1;
  const key = JSON.stringify(`${Date.now()}-${heldSequence}`);
  // Callers pass a statement-like expression, possibly ending in `;`.
  const expression = code.trim().replace(/;+\s*$/, '');
  await evaluate(`(() => {
    const store = (window.__openchamberHeld ||= {});
    const slot = store[${key}] = { done: false, value: null, error: null, wake: [] };
    const finish = () => { slot.done = true; for (const wake of slot.wake.splice(0)) wake(); };
    Promise.resolve((
${expression}
)).then((value) => { slot.value = value ?? null; finish(); }, (error) => { slot.error = String(error && error.message || error); finish(); });
    return true;
  })()`, userGesture);
  for (;;) {
    const result = await evaluate(`(async () => {
      const slot = window.__openchamberHeld && window.__openchamberHeld[${key}];
      if (!slot) return { gone: true };
      if (!slot.done) await new Promise((resolve) => { slot.wake.push(resolve); setTimeout(resolve, ${HELD_POLL_MS}); });
      if (!slot.done) return { pending: true };
      delete window.__openchamberHeld[${key}];
      return { done: true, value: slot.value, error: slot.error };
    })()`) as { gone?: boolean; pending?: boolean; value?: unknown; error?: string | null } | null;
    if (!result || result.gone) return null;
    if (result.pending) continue;
    if (result.error) throw new Error(result.error);
    return result.value ?? null;
  }
};
