import { describe, expect, test } from 'bun:test';

import { offeredMobileWorkspaceTabs, orderMobileWorkspaceTabs, shownMobileWorkspaceTabs, storedMobileWorkspaceTabOrder, stripMobileWorkspaceTabs, withReceivedPagesTab } from './mobileWorkspaceTabs';

describe('mobile workspace tabs', () => {
  test('the native app adds the browser before Project knowledge, also to an order saved without it', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { Capacitor: { isNativePlatform: () => true }, location: { protocol: 'https:' } },
    });
    try {
      expect(orderMobileWorkspaceTabs([])).toEqual(['status', 'changes', 'files', 'terminal', 'preview', 'notes']);
      expect(orderMobileWorkspaceTabs(['notes', 'status', 'changes', 'files', 'terminal'])).toEqual(['preview', 'notes', 'status', 'changes', 'files', 'terminal']);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'window', descriptor);
      else Reflect.deleteProperty(globalThis, 'window');
    }
  });

  test('hosted mobile never offers the browser and drops it from a saved order', () => {
    expect(orderMobileWorkspaceTabs(['preview', 'files'])).toEqual(['status', 'changes', 'files', 'terminal', 'notes']);
  });

  test('hosted mobile offers the browser while Chrome on the server draws it, in its saved place', () => {
    expect(orderMobileWorkspaceTabs([], ['preview'])).toEqual(['status', 'changes', 'files', 'terminal', 'preview', 'notes']);
    expect(orderMobileWorkspaceTabs(['preview', 'files'], ['plugin:tasks', 'preview'])).toEqual(['status', 'changes', 'terminal', 'preview', 'files', 'notes', 'plugin:tasks']);
    expect(shownMobileWorkspaceTabs([], ['preview'], ['preview'])).toEqual(['status', 'changes', 'files', 'terminal', 'notes']);
    expect(stripMobileWorkspaceTabs([], ['preview'], 'preview', ['preview'])).toEqual(['status', 'changes', 'files', 'terminal', 'preview', 'notes']);
    expect(storedMobileWorkspaceTabOrder(['preview', 'status', 'changes', 'files', 'terminal', 'notes'], [])).toEqual(['preview', 'status', 'changes', 'files', 'terminal', 'notes']);
  });

  test('the browser is offered on the phone surface only, and only while Chrome on the server is the browser', () => {
    expect(offeredMobileWorkspaceTabs(['plugin:tasks'], 'openchamber-builtin-server-browser')).toEqual(['plugin:tasks']);
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { __OPENCHAMBER_SURFACE__: 'mobile', location: { protocol: 'https:', search: '' } },
    });
    try {
      expect(offeredMobileWorkspaceTabs(['plugin:tasks'], 'openchamber-builtin-server-browser')).toEqual(['plugin:tasks', 'preview']);
      expect(offeredMobileWorkspaceTabs(['plugin:tasks'], 'builtin')).toEqual(['plugin:tasks']);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'window', descriptor);
      else Reflect.deleteProperty(globalThis, 'window');
    }
  });

  test('a saved order keeps its tabs and places tabs it does not name where they go by default', () => {
    expect(orderMobileWorkspaceTabs(['terminal', 'gone', 'changes', 'terminal'])).toEqual(['status', 'files', 'terminal', 'changes', 'notes']);
    expect(orderMobileWorkspaceTabs([])).toEqual(['status', 'changes', 'files', 'terminal', 'notes']);
  });

  test('an order saved before Status existed gets it first and loses the MCP tab', () => {
    expect(orderMobileWorkspaceTabs(['mcp', 'files', 'changes', 'terminal', 'notes'])).toEqual(['status', 'files', 'changes', 'terminal', 'notes']);
  });

  test('hidden tabs leave the strip, but never all of them', () => {
    expect(shownMobileWorkspaceTabs(['files'], ['changes', 'mcp'])).toEqual(['status', 'files', 'terminal', 'notes']);
    expect(shownMobileWorkspaceTabs([], ['status', 'changes', 'files', 'terminal', 'notes'])).toEqual(['status', 'changes', 'files', 'terminal', 'notes']);
  });

  test('a hidden tab something opened stays in the strip, in its place, while it is open', () => {
    expect(stripMobileWorkspaceTabs([], ['files', 'terminal'], 'files')).toEqual(['status', 'changes', 'files', 'notes']);
    expect(stripMobileWorkspaceTabs([], ['files', 'terminal'], 'notes')).toEqual(['status', 'changes', 'notes']);
  });

  test('a new extension tab goes last; a saved one keeps its place; one not available now is left out', () => {
    expect(orderMobileWorkspaceTabs([], ['plugin:tasks'])).toEqual(['status', 'changes', 'files', 'terminal', 'notes', 'plugin:tasks']);
    const saved = ['plugin:tasks', 'status', 'changes', 'plugin:gone', 'files', 'terminal', 'notes'];
    expect(orderMobileWorkspaceTabs(saved, ['plugin:tasks', 'plugin:config'])).toEqual(['plugin:tasks', 'status', 'changes', 'files', 'terminal', 'notes', 'plugin:config']);
    expect(orderMobileWorkspaceTabs(saved)).toEqual(['status', 'changes', 'files', 'terminal', 'notes']);
    expect(shownMobileWorkspaceTabs(saved, ['plugin:tasks'], ['plugin:tasks'])).toEqual(['status', 'changes', 'files', 'terminal', 'notes']);
  });

  test('a stored order keeps the saved place of an extension that is not available now', () => {
    const previous = ['status', 'plugin:gone', 'changes', 'files', 'terminal', 'notes', 'plugin:tasks'];
    expect(storedMobileWorkspaceTabOrder(['plugin:tasks', 'status', 'changes', 'files', 'terminal', 'notes'], previous))
      .toEqual(['plugin:tasks', 'status', 'plugin:gone', 'changes', 'files', 'terminal', 'notes']);
    // Unavailable tabs that led the saved order stay first, in their saved order.
    expect(storedMobileWorkspaceTabOrder(['notes', 'status', 'changes', 'files', 'terminal'], ['plugin:a', 'plugin:b', 'status', 'changes', 'files', 'terminal', 'notes']))
      .toEqual(['plugin:a', 'plugin:b', 'notes', 'status', 'changes', 'files', 'terminal']);
    expect(storedMobileWorkspaceTabOrder(['notes', 'unknown', 'files'], [])).toEqual(['status', 'changes', 'terminal', 'notes', 'files']);
  });
});

describe('the shared pages tab', () => {
  test('sits right after Status wherever the user put Status, and first without it', () => {
    expect(withReceivedPagesTab(['changes', 'status', 'files'])).toEqual(['changes', 'status', 'pages', 'files']);
    expect(withReceivedPagesTab(['status', 'changes'])).toEqual(['status', 'pages', 'changes']);
    expect(withReceivedPagesTab(['changes', 'files'])).toEqual(['pages', 'changes', 'files']);
    expect(withReceivedPagesTab(['changes', 'pages', 'status'])).toEqual(['changes', 'status', 'pages']);
  });
});
