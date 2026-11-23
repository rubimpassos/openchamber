import { describe, expect, it, vi } from 'vitest';

import { createStartupPipelineRuntime } from './startup-pipeline-runtime.js';

describe('startup pipeline runtime', () => {
  it('leaves terminal execution unavailable when serving a front door', async () => {
    // Given a front door whose owner account must never construct a terminal.
    const runtime = createStartupPipelineRuntime({
      createTerminalRuntime: () => { throw new Error('owner terminal constructed'); },
      createDictationRuntime: () => ({}),
      createMessageStreamWsRuntime: () => ({}),
      createServerStartupRuntime: () => ({
        resolveBindHost: () => '127.0.0.1',
        startListeningAndMaybeTunnel: async () => ({ activePort: 3901 }),
        attachProcessHandlers: () => {},
      }),
    });

    // When the shared frame starts in front-door mode.
    const result = await runtime.run({
      frontDoor: true,
      app: {},
      setupProxy: () => {},
      staticRoutesRuntime: { registerStaticRoutes: () => {} },
      apiOnly: false,
      tunnelRuntimeContext: { setActivePort: () => {} },
      scheduleOpenCodeApiDetection: () => {},
      bootstrapOpenCodeAtStartup: async () => {},
      process: {},
      crypto: {},
      server: {},
      attachSignals: false,
    });

    // Then the owner has no terminal runtime to execute project commands.
    expect(result.terminalRuntime).toBeNull();
  });

  it('publishes the listening port before bootstrapping managed OpenCode', async () => {
    const order = [];
    const broadcastUiEvent = vi.fn();
    const createTerminalRuntime = vi.fn(() => ({}));
    const runtime = createStartupPipelineRuntime({
      createTerminalRuntime,
      createDictationRuntime: () => ({}),
      createMessageStreamWsRuntime: () => ({}),
      createServerStartupRuntime: () => ({
        resolveBindHost: () => '127.0.0.1',
        startListeningAndMaybeTunnel: async () => {
          order.push('listen');
          return { activePort: 3901 };
        },
        attachProcessHandlers: vi.fn(),
      }),
    });

    await runtime.run({
      app: {},
      broadcastUiEvent,
      setupProxy: vi.fn(),
      staticRoutesRuntime: { registerStaticRoutes: vi.fn() },
      apiOnly: false,
      tunnelRuntimeContext: {
        setActivePort: (port) => order.push(`port:${port}`),
      },
      scheduleOpenCodeApiDetection: () => order.push('detect'),
      bootstrapOpenCodeAtStartup: () => order.push('bootstrap'),
      process: {},
      crypto: {},
      server: {},
      attachSignals: false,
    });

    expect(order).toEqual(['listen', 'port:3901', 'detect', 'bootstrap']);
    expect(createTerminalRuntime).toHaveBeenCalledWith(expect.objectContaining({ broadcastUiEvent }));
  });
});
