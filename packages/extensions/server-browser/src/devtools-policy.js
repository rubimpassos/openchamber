import { createDevToolsHandles } from './devtools-handles.js';
import { z } from 'zod';
import { readDevToolsCommand, readDevToolsEvent, withProtocolSession } from './devtools-wire.js';

const METHODS = {
  'Inspector.enable': '', 'Inspector.disable': '',
  'Console.enable': '', 'Console.disable': '', 'Console.clearMessages': '',
  'Log.enable': '', 'Log.disable': '', 'Log.clear': '',
  'Runtime.enable': '', 'Runtime.disable': '', 'Runtime.discardConsoleEntries': '',
  'Runtime.evaluate': 'expression objectGroup includeCommandLineAPI silent contextId returnByValue generatePreview userGesture awaitPromise throwOnSideEffect timeout disableBreaks replMode allowUnsafeEvalBlockedByCSP uniqueContextId serializationOptions',
  'Runtime.callFunctionOn': 'functionDeclaration objectId arguments silent returnByValue generatePreview userGesture awaitPromise executionContextId objectGroup throwOnSideEffect uniqueContextId serializationOptions',
  'Runtime.getProperties': 'objectId ownProperties accessorPropertiesOnly generatePreview nonIndexedPropertiesOnly',
  'Runtime.releaseObject': 'objectId', 'Runtime.releaseObjectGroup': 'objectGroup',
  'Runtime.getHeapUsage': '', 'Runtime.globalLexicalScopeNames': 'executionContextId',
  'Runtime.compileScript': 'expression sourceURL persistScript executionContextId',
  'Runtime.runScript': 'scriptId executionContextId objectGroup silent includeCommandLineAPI returnByValue generatePreview awaitPromise',
  'Runtime.queryObjects': 'prototypeObjectId objectGroup', 'Runtime.getIsolateId': '',
  'Runtime.runIfWaitingForDebugger': '', 'Runtime.setCustomObjectFormatterEnabled': 'enabled',
  'Debugger.enable': 'maxScriptsCacheSize', 'Debugger.disable': '', 'Debugger.pause': '',
  'Debugger.resume': 'terminateOnResume', 'Debugger.stepInto': 'breakOnAsyncCall skipList',
  'Debugger.stepOut': '', 'Debugger.stepOver': 'skipList',
  'Debugger.setPauseOnExceptions': 'state', 'Debugger.setBreakpointsActive': 'active',
  'Debugger.setAsyncCallStackDepth': 'maxDepth', 'Debugger.setSkipAllPauses': 'skip',
  'Debugger.setBlackboxPatterns': 'patterns skipAnonymous', 'Debugger.setBlackboxedRanges': 'scriptId positions',
  'Debugger.getScriptSource': 'scriptId', 'Debugger.setScriptSource': 'scriptId scriptSource dryRun allowTopFrameEditing',
  'Debugger.getPossibleBreakpoints': 'start end restrictToFunction',
  'Debugger.setBreakpoint': 'location condition', 'Debugger.setBreakpointByUrl': 'lineNumber url urlRegex scriptHash columnNumber condition',
  'Debugger.removeBreakpoint': 'breakpointId', 'Debugger.continueToLocation': 'location targetCallFrames',
  'Debugger.evaluateOnCallFrame': 'callFrameId expression objectGroup includeCommandLineAPI silent returnByValue generatePreview throwOnSideEffect timeout',
  'Debugger.setVariableValue': 'scopeNumber variableName newValue callFrameId',
  'Debugger.restartFrame': 'callFrameId mode', 'Debugger.setReturnValue': 'newValue',
  'Debugger.disassembleWasmModule': 'scriptId',
  'DOM.enable': 'includeWhitespace', 'DOM.disable': '', 'DOM.getDocument': 'depth pierce',
  'DOM.getFlattenedDocument': 'depth pierce', 'DOM.describeNode': 'nodeId backendNodeId objectId depth pierce',
  'DOM.requestChildNodes': 'nodeId depth pierce', 'DOM.requestNode': 'objectId',
  'DOM.resolveNode': 'nodeId backendNodeId objectGroup executionContextId',
  'DOM.querySelector': 'nodeId selector', 'DOM.querySelectorAll': 'nodeId selector',
  'DOM.getOuterHTML': 'nodeId backendNodeId objectId includeShadowDOM',
  'DOM.setOuterHTML': 'nodeId outerHTML', 'DOM.setNodeValue': 'nodeId value',
  'DOM.setNodeName': 'nodeId name', 'DOM.removeNode': 'nodeId',
  'DOM.setAttributeValue': 'nodeId name value', 'DOM.setAttributesAsText': 'nodeId text name',
  'DOM.removeAttribute': 'nodeId name', 'DOM.getAttributes': 'nodeId',
  'DOM.getBoxModel': 'nodeId backendNodeId objectId', 'DOM.getContentQuads': 'nodeId backendNodeId objectId',
  'DOM.getNodeForLocation': 'x y includeUserAgentShadowDOM ignorePointerEventsNone',
  'DOM.getNodesForSubtreeByStyle': 'nodeId computedStyles pierce',
  'DOM.pushNodesByBackendIdsToFrontend': 'backendNodeIds',
  'DOM.pushNodeByPathToFrontend': 'path', 'DOM.focus': 'nodeId backendNodeId objectId',
  'DOM.scrollIntoViewIfNeeded': 'nodeId backendNodeId objectId rect',
  'DOM.moveTo': 'nodeId targetNodeId insertBeforeNodeId', 'DOM.copyTo': 'nodeId targetNodeId insertBeforeNodeId',
  'DOM.performSearch': 'query includeUserAgentShadowDOM', 'DOM.getSearchResults': 'searchId fromIndex toIndex',
  'DOM.discardSearchResults': 'searchId', 'DOM.markUndoableState': '', 'DOM.undo': '', 'DOM.redo': '',
  'DOM.getNodeStackTraces': 'nodeId', 'DOM.setNodeStackTracesEnabled': 'enable',
  'CSS.enable': '', 'CSS.disable': '', 'CSS.getMatchedStylesForNode': 'nodeId',
  'CSS.getComputedStyleForNode': 'nodeId', 'CSS.getInlineStylesForNode': 'nodeId',
  'CSS.getStyleSheetText': 'styleSheetId', 'CSS.setStyleSheetText': 'styleSheetId text',
  'CSS.createStyleSheet': 'frameId force', 'CSS.setStyleTexts': 'edits nodeForPropertySyntaxValidation',
  'CSS.setRuleSelector': 'styleSheetId range selector', 'CSS.addRule': 'styleSheetId ruleText location nodeForPropertySyntaxValidation',
  'CSS.forcePseudoState': 'nodeId forcedPseudoClasses', 'CSS.getMediaQueries': '',
  'CSS.getPlatformFontsForNode': 'nodeId', 'CSS.getBackgroundColors': 'nodeId',
  'CSS.getLayersForNode': 'nodeId', 'CSS.getLocationForSelector': 'styleSheetId selectorText',
  'CSS.setEffectivePropertyValueForNode': 'nodeId propertyName value',
  'CSS.setMediaText': 'styleSheetId range text', 'CSS.setKeyframeKey': 'styleSheetId range keyText',
  'CSS.setSupportsText': 'styleSheetId range text', 'CSS.setContainerQueryText': 'styleSheetId range text',
  'CSS.trackComputedStyleUpdates': 'propertiesToTrack', 'CSS.takeComputedStyleUpdates': '',
  'Overlay.enable': '', 'Overlay.disable': '', 'Overlay.hideHighlight': '',
  'Overlay.highlightNode': 'highlightConfig nodeId backendNodeId objectId selector',
  'Overlay.highlightRect': 'x y width height color outlineColor',
  'Overlay.highlightQuad': 'quad color outlineColor',
  'Overlay.setInspectMode': 'mode highlightConfig',
  'Overlay.setShowGridOverlays': 'gridNodeHighlightConfigs', 'Overlay.setShowFlexOverlays': 'flexNodeHighlightConfigs',
  'Overlay.setShowScrollSnapOverlays': 'scrollSnapHighlightConfigs',
  'Overlay.setShowContainerQueryOverlays': 'containerQueryHighlightConfigs',
  'Overlay.setShowIsolatedElements': 'isolatedElementHighlightConfigs',
  'Overlay.setShowAdHighlights': 'show', 'Overlay.setShowDebugBorders': 'show',
  'Overlay.setShowFPSCounter': 'show', 'Overlay.setShowPaintRects': 'result',
  'Overlay.setShowLayoutShiftRegions': 'result', 'Overlay.setShowViewportSizeOnResize': 'show',
  'Overlay.setPausedInDebuggerMessage': 'message',
  'Page.enable': 'enableFileChooserOpenedEvent', 'Page.disable': '',
  'Page.getResourceTree': '', 'Page.getFrameTree': '', 'Page.getLayoutMetrics': '',
  'Page.getResourceContent': 'frameId url', 'Page.searchInResource': 'frameId url query caseSensitive isRegex',
  'Page.navigate': 'url referrer transitionType frameId referrerPolicy',
  'Page.reload': 'ignoreCache scriptToEvaluateOnLoad loaderId', 'Page.stopLoading': '',
  'Page.getNavigationHistory': '', 'Page.navigateToHistoryEntry': 'entryId',
  'Page.setLifecycleEventsEnabled': 'enabled',
  'Network.enable': 'maxTotalBufferSize maxResourceBufferSize maxPostDataSize reportDirectSocketTraffic enableDurableMessages',
  'Network.disable': '', 'Network.getResponseBody': 'requestId', 'Network.getRequestPostData': 'requestId',
  'Network.searchInResponseBody': 'requestId query caseSensitive isRegex',
  'Network.replayXHR': 'requestId', 'Network.setCacheDisabled': 'cacheDisabled',
  'Network.setBypassServiceWorker': 'bypass', 'Network.setBlockedURLs': 'urls urlPatterns',
  'Network.setAttachDebugStack': 'enabled', 'Network.setExtraHTTPHeaders': 'headers',
  'Network.loadNetworkResource': 'frameId url options',
  'Security.enable': '', 'Security.disable': '',
  'Accessibility.enable': '', 'Accessibility.disable': '',
  'Accessibility.getFullAXTree': 'depth frameId', 'Accessibility.getRootAXNode': 'frameId',
  'Accessibility.getPartialAXTree': 'nodeId backendNodeId objectId fetchRelatives',
  'Accessibility.getAXNodeAndAncestors': 'nodeId backendNodeId objectId',
  'Accessibility.getChildAXNodes': 'id frameId', 'Accessibility.queryAXTree': 'nodeId backendNodeId objectId accessibleName role',
  'DOMDebugger.getEventListeners': 'objectId depth pierce',
  'DOMDebugger.setDOMBreakpoint': 'nodeId type', 'DOMDebugger.removeDOMBreakpoint': 'nodeId type',
  'DOMDebugger.setEventListenerBreakpoint': 'eventName targetName', 'DOMDebugger.removeEventListenerBreakpoint': 'eventName targetName',
  'DOMDebugger.setXHRBreakpoint': 'url', 'DOMDebugger.removeXHRBreakpoint': 'url',
  'EventBreakpoints.setInstrumentationBreakpoint': 'eventName', 'EventBreakpoints.removeInstrumentationBreakpoint': 'eventName',
  'Target.getTargetInfo': 'targetId', 'Target.setAutoAttach': 'autoAttach waitForDebuggerOnStart flatten filter',
  'Target.attachToTarget': 'targetId flatten', 'Target.detachFromTarget': 'sessionId',
  'IO.read': 'handle offset size', 'IO.close': 'handle',
};
const autoAttachSchema = z.object({ autoAttach: z.boolean(), flatten: z.literal(true), waitForDebuggerOnStart: z.boolean() }).passthrough();
const resourceOptionsSchema = z.object({ disableCache: z.boolean().optional(), includeCredentials: z.boolean().optional() }).strict();
const groupSchema = z.string().max(512).optional();
const attachmentSchema = z.object({
  sessionId: z.union([z.string().min(1).max(512), z.number().int().positive().max(Number.MAX_SAFE_INTEGER)]),
  targetInfo: z.object({
    targetId: z.union([z.string().min(1).max(512), z.number().int().positive().max(Number.MAX_SAFE_INTEGER)]),
    type: z.string().optional(),
  }).passthrough(),
}).passthrough();
const denied = (message) => ({ ok: false, response: withProtocolSession({
  id: message.id,
  error: { code: -32000, message: 'Command is not available for this page. Browser administration, server files and Performance tracing are disabled.' },
}, message.sessionId) });

export const createDevToolsPolicy = ({ targetId, version = {}, refuses = () => false }) => {
  const sessions = new Map([['', { targetId, parent: null, autoAttach: false, handles: createDevToolsHandles({ targetId }) }]]);
  const pending = new Map();
  let pendingBytes = 0;
  const retain = (key, command) => {
    const bytes = Buffer.byteLength(JSON.stringify(command));
    if (pending.size >= 1024 || pendingBytes + bytes > 2 * 1024 * 1024) return false;
    pending.set(key, { ...command, bytes });
    pendingBytes += bytes;
    return true;
  };
  const release = (key) => {
    const entry = pending.get(key);
    if (entry) { pendingBytes -= entry.bytes; pending.delete(key); }
    return entry;
  };
  let internalId = -1;
  const safeUrl = (value) => {
    if (value === 'about:blank') return true;
    try { return ['http:', 'https:'].includes(new URL(value).protocol) && !refuses(value); }
    catch { return false; }
  };
  const forget = (id) => {
    for (const [child, owner] of sessions) if (owner.parent === id) forget(child);
    sessions.delete(id);
    for (const [key, entry] of pending) if (entry.session === id) release(key);
  };
  return {
    command(raw) {
      const message = readDevToolsCommand(raw);
      if (!message) return { ok: false };
      const session = message.sessionId ?? '';
      const owner = sessions.get(session);
      const key = JSON.stringify([session, message.id]);
      if (!owner || pending.has(key) || pending.size >= 1024) return { ok: false };
      if (message.method === 'Browser.getVersion') return { ok: false, response: withProtocolSession({ id: message.id, result: version }, session) };
      const fields = METHODS[message.method];
      const params = message.params ?? {};
      if (!Object.hasOwn(METHODS, message.method) || Object.keys(params).some((name) => !fields.split(' ').includes(name))
        || !owner.handles.accepts(params)) return denied(message);
      const group = groupSchema.safeParse(params.objectGroup);
      if (!group.success) return denied(message);
      if (message.method === 'Target.setAutoAttach') {
        const attach = autoAttachSchema.safeParse(params);
        if (!attach.success) return denied(message);
        owner.autoAttach = attach.data.autoAttach;
        message.params = { ...attach.data, filter: [{ type: 'iframe' }, { type: 'worker' }, { exclude: true }] };
      }
      if (message.method === 'Target.getTargetInfo' && params.targetId !== undefined && params.targetId !== owner.targetId) return denied(message);
      if (message.method === 'Target.attachToTarget' && (params.targetId !== owner.targetId || params.flatten !== true)) return denied(message);
      if (message.method === 'Target.detachFromTarget' && sessions.get(params.sessionId)?.parent !== session) return denied(message);
      if (['Page.navigate', 'Network.loadNetworkResource', 'Page.getResourceContent', 'Page.searchInResource'].includes(message.method)
        && (!safeUrl(params.url) || (message.method === 'Network.loadNetworkResource' && !owner.handles.has('frame', params.frameId)))) return denied(message);
      if (message.method === 'Network.loadNetworkResource') {
        const options = resourceOptionsSchema.safeParse(params.options);
        if (!options.success) return denied(message);
        params.options = options.data;
      }
      if (params.referrer !== undefined && !safeUrl(params.referrer)) return denied(message);
      if (message.method === 'IO.read' && params.size !== undefined && (!Number.isInteger(params.size) || params.size < 1 || params.size > 1024 * 1024)) return denied(message);
      const ownership = {
        objectGroup: group.data, objectId: params.objectId, prototypeObjectId: params.prototypeObjectId,
        contextId: params.contextId, executionContextId: params.executionContextId, uniqueContextId: params.uniqueContextId, handle: params.handle,
      };
      if (!retain(key, { method: message.method, session, params: ownership })) return { ok: false };
      return { ok: true, message };
    },
    event(raw) {
      const message = readDevToolsEvent(raw);
      if (!message) return { ok: false };
      const session = message.sessionId ?? '';
      const owner = sessions.get(session);
      if (!owner) return { ok: false };
      if (message.id !== undefined) {
        const key = JSON.stringify([session, message.id]);
        const command = pending.get(key);
        if (!command || (message.error === undefined && message.result === undefined)) return { ok: false };
        release(key);
        if (command.internal) return { ok: true, message: null };
        if (!message.error) owner.handles.complete(command.method, command.params, message.result);
      } else {
        if (message.method === undefined || message.params === undefined) return { ok: false };
        const params = message.params;
        if (message.method === 'Target.attachedToTarget') {
          const attachment = attachmentSchema.safeParse(params);
          if (!attachment.success) return { ok: false };
          const info = attachment.data.targetInfo;
          const attachedSession = attachment.data.sessionId;
          if (sessions.has(attachedSession) || sessions.size >= 128
            || !(info.targetId === owner.targetId || (owner.autoAttach && ['iframe', 'worker'].includes(info.type)))) return { ok: false };
          sessions.set(attachedSession, { targetId: info.targetId, parent: session, autoAttach: false, handles: createDevToolsHandles(info) });
        } else if (message.method === 'Target.detachedFromTarget') {
          if (sessions.get(params.sessionId)?.parent !== session) return { ok: false };
          forget(params.sessionId);
        } else if (message.method.startsWith('Target.') || message.method.startsWith('Browser.') || message.method.startsWith('Tracing.')) return { ok: false };
        switch (owner.handles.event(message.method, params)) {
          case 'drop': return { ok: true, message: null };
          case 'resume': {
            const id = internalId--;
            if (!retain(JSON.stringify([session, id]), { internal: true, session })) return { ok: false };
            return { ok: true, message: null, command: withProtocolSession({ id, method: 'Debugger.resume' }, session) };
          }
          case 'forward': break;
          default: throw new TypeError('Unknown DevTools authority decision');
        }
      }
      return { ok: true, message };
    },
  };
};
