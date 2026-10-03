import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

test('bundles the guest entry when schema and server dependencies are unavailable', async () => {
  // Given the public guest entry, not a private subset of its exports.
  const entry = fileURLToPath(new URL('./index.ts', import.meta.url));
  // When bundled for an iframe with forbidden runtime imports rejected.
  const result = await Bun.build({
    entrypoints: [entry], target: 'browser', format: 'iife', write: false,
    plugins: [{ name: 'guest-boundary', setup(build) {
      build.onResolve({ filter: /^(zod(?:\/|$)|node:|bun$)/u }, (args) => {
        throw new Error(`Guest entry imports a host dependency: ${args.path}`);
      });
    } }],
  });
  // Then guest consumers do not load Zod or a server runtime.
  expect(result.success).toBe(true);
  expect(result.logs).toEqual([]);
});
