import { z } from 'zod';
import { readProtocolIdentity } from './devtools-wire.js';

const REFERENCES = {
  frameId: 'frame', contextId: 'context', executionContextId: 'context', uniqueContextId: 'uniqueContext',
  objectId: 'object', prototypeObjectId: 'object', nodeId: 'node', backendNodeId: 'backendNode',
  targetNodeId: 'node', insertBeforeNodeId: 'node', nodeForPropertySyntaxValidation: 'node',
  backendNodeIds: 'backendNode', styleSheetId: 'style', scriptId: 'script', callFrameId: 'callFrame',
  requestId: 'request', searchId: 'search', handle: 'stream', breakpointId: 'breakpoint', loaderId: 'loader',
};
const object = (value) => Object(value) === value && !Array.isArray(value);
const propertyDescriptorSchema = z.object({
  name: z.string(),
  value: z.object({ type: z.string() }).passthrough(),
}).passthrough();

export const createDevToolsHandles = ({ targetId, type = 'page' }) => {
  const handles = new Map([['frame', new Set([targetId])]]);
  const objectOwners = new Map();
  const contextIds = new Map();
  let defaultContext;
  const hiddenContexts = new Set();
  const hiddenScripts = new Set();
  const scriptContexts = new Map();
  const remember = (kind, value, authority) => {
    const id = readProtocolIdentity(value);
    if (id === null || (kind === 'script' && hiddenScripts.has(id))) return;
    if (kind === 'script' && !handles.get('context')?.has(scriptContexts.get(id))) return;
    const entries = handles.get(kind) ?? new Set();
    if (entries.size >= 16_384 && !entries.has(id)) throw new RangeError('DevTools handle limit exceeded');
    entries.add(id);
    handles.set(kind, entries);
    if (kind === 'object') objectOwners.set(id, authority);
  };
  const hide = (set, value) => {
    const id = readProtocolIdentity(value);
    if (id === null) return;
    if (set.size >= 16_384 && !set.has(id)) throw new RangeError('DevTools private handle limit exceeded');
    set.add(id);
  };
  const collect = (value, authority = {}) => {
    const walk = (node, parent = '', depth = 0) => {
      if (!object(node) && !Array.isArray(node)) return;
      if (depth > 64) throw new RangeError('DevTools protocol nesting limit exceeded');
      for (const [key, entry] of Object.entries(node)) {
        let content = entry;
        if (key === 'value') {
          const descriptor = propertyDescriptorSchema.safeParse(node);
          if (!descriptor.success) continue;
          content = descriptor.data.value;
        }
        if (REFERENCES[key]) for (const id of Array.isArray(entry) ? entry : [entry]) remember(REFERENCES[key], id, authority);
        if (key === 'id' && parent === 'frame') remember('frame', entry);
        if (key === 'id' && parent === 'context') remember('context', entry);
        if (key === 'uniqueId' && parent === 'context') remember('uniqueContext', entry);
        if (key === 'stream') remember('stream', entry);
        walk(content, key, depth + 1);
      }
    };
    walk(value);
  };
  const accepts = (value, depth = 0) => {
    if (!object(value) && !Array.isArray(value)) return true;
    if (depth > 64) return false;
    return Object.entries(value).every(([key, entry]) => {
      if (key === 'value') return true;
      const kind = REFERENCES[key];
      if (kind && !(Array.isArray(entry) ? entry : [entry]).every((id) => handles.get(kind)?.has(id))) return false;
      return accepts(entry, depth + 1);
    });
  };
  const releaseObject = (id) => {
    handles.get('object')?.delete(id);
    objectOwners.delete(id);
  };
  return {
    accepts,
    has(kind, id) { return handles.get(kind)?.has(id) === true; },
    complete(method, params, result) {
      if (method === 'Runtime.releaseObject') releaseObject(params.objectId);
      if (method === 'Runtime.releaseObjectGroup') {
        for (const [id, authority] of objectOwners) if (authority.group === params.objectGroup) releaseObject(id);
      }
      if (method === 'IO.close') handles.get('stream')?.delete(params.handle);
      const parent = objectOwners.get(params.objectId) ?? objectOwners.get(params.prototypeObjectId);
      const context = params.contextId ?? params.executionContextId ?? contextIds.get(params.uniqueContextId) ?? parent?.context ?? defaultContext;
      if (method === 'Runtime.compileScript') {
        const script = readProtocolIdentity(result.scriptId);
        if (script !== null && handles.get('context')?.has(context)) scriptContexts.set(script, context);
      }
      collect(result, {
        group: params.objectGroup ?? parent?.group,
        context,
      });
    },
    event(method, params) {
      if (method === 'Runtime.executionContextCreated') {
        const context = params.context;
        if (type !== 'worker' && context?.auxData?.isDefault !== true) {
          hide(hiddenContexts, context?.id);
          return 'drop';
        }
        const uniqueId = readProtocolIdentity(context?.uniqueId);
        if (uniqueId !== null) contextIds.set(uniqueId, context.id);
        if (type === 'worker' || context?.auxData?.frameId === targetId) defaultContext = context.id;
      }
      if (method === 'Debugger.scriptParsed' || method === 'Debugger.scriptFailedToParse') {
        const script = readProtocolIdentity(params.scriptId);
        const context = readProtocolIdentity(params.executionContextId);
        if (script === null || context === null) return 'drop';
        scriptContexts.set(script, context);
        if (!handles.get('context')?.has(context)) {
          hide(hiddenScripts, script);
          handles.get('script')?.delete(script);
          return 'drop';
        }
        hiddenScripts.delete(script);
      }
      if (method === 'Debugger.paused'
        && params.callFrames?.some((frame) => !handles.get('script')?.has(frame.location?.scriptId))) return 'resume';
      if (method !== 'Runtime.executionContextDestroyed'
        && hiddenContexts.has(params.executionContextId ?? params.exceptionDetails?.executionContextId)) return 'drop';
      if (method === 'Runtime.executionContextsCleared') {
        for (const kind of ['context', 'uniqueContext', 'object', 'callFrame', 'script']) handles.delete(kind);
        hiddenContexts.clear();
        hiddenScripts.clear();
        scriptContexts.clear();
        objectOwners.clear();
        contextIds.clear();
        defaultContext = undefined;
      }
      if (method === 'Runtime.executionContextDestroyed') {
        handles.get('context')?.delete(params.executionContextId);
        handles.get('uniqueContext')?.delete(params.executionContextUniqueId);
        for (const [id, authority] of objectOwners) if (authority.context === params.executionContextId) releaseObject(id);
        for (const [id, owner] of scriptContexts) if (owner === params.executionContextId) {
          handles.get('script')?.delete(id);
          hiddenScripts.delete(id);
          scriptContexts.delete(id);
        }
        contextIds.delete(params.executionContextUniqueId);
        if (defaultContext === params.executionContextId) defaultContext = undefined;
        if (hiddenContexts.delete(params.executionContextId)) return 'drop';
      } else collect(params, {
        group: ['Runtime.consoleAPICalled', 'Runtime.exceptionThrown'].includes(method) ? 'console' : undefined,
        context: params.executionContextId ?? defaultContext,
      });
      if (method === 'Page.frameDetached') handles.get('frame')?.delete(params.frameId);
      if (method === 'Debugger.resumed') handles.delete('callFrame');
      if (method === 'DOM.documentUpdated') for (const kind of ['node', 'backendNode', 'search']) handles.delete(kind);
      return 'forward';
    },
  };
};
