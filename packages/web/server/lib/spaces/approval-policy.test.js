import { describe, expect, it } from 'vitest';

import rules from './gatekeeper-program.cjs';

const policy = rules.approvalPolicy;
const OPENAI = { providerID: 'openai', modelID: 'gpt-4.1' };
const ANTHROPIC = { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' };
const REMOTE = 'https://publisher.test/hook';
const SCHEMA = { type: 'object', properties: { tools: { type: 'string' }, container: { type: 'string' }, url: { const: REMOTE } } };
const context = (format) => ({ protocol: format === 'messages' ? 'anthropic' : 'openai', rest: format === 'chat' ? '/chat/completions' : `/${format}`, model: format === 'messages' ? ANTHROPIC : OPENAI });
const bodyOf = (format) => format === 'responses' ? { model: OPENAI.modelID, input: 'Hello' } : { model: context(format).model.modelID, messages: [{ role: 'user', content: 'Hello' }] };

describe('approval operational nodes', () => {
  it.each([null, false, 42, {}, [42], new String('Hello'), { [Symbol.toStringTag]: 'String' }].map((input) => ({ input })))('refuses non-text input $input without coercion', ({ input }) => {
    // Given the same reviewed model and protocol as a valid text request.
    const body = bodyOf('responses');
    expect(policy.bodyAllowed(body, context('responses'))).toBe(true);
    // When the input is not a primitive JSON string or a valid message list.
    const allowed = policy.bodyAllowed({ ...body, input }, context('responses'));
    // Then invalid representations cannot become inference text.
    expect(allowed).toBe(false);
  });

  it.each([null, false, 42, 'effort', [], new String('low'), new Date(0), new Map(), Object.create(null)].map((reasoning) => ({ reasoning })))('refuses non-JSON operational objects $reasoning', ({ reasoning }) => {
    // Given an operational field whose ordinary decoded JSON form works.
    const body = { ...bodyOf('responses'), reasoning: JSON.parse('{"effort":"low"}') };
    expect(policy.bodyAllowed(body, context('responses'))).toBe(true);
    // When an in-process caller supplies a different representation.
    const allowed = policy.bodyAllowed({ ...body, reasoning }, context('responses'));
    // Then the JSON object contract is enforced at that operational node.
    expect(allowed).toBe(false);
  });

  it.each([null, false, 42, {}, new String('https://api.openai.com/v1'), { [Symbol.toStringTag]: 'String' }])('refuses non-primitive upstream %j', (upstream) => {
    // Given a supported decoded host grant.
    const grant = { id: 'openai', upstream: 'https://api.openai.com/v1', header: 'authorization' };
    expect(policy.protocolOf(grant)).toBe('openai');
    // When the upstream is replaced by a non-string representation.
    const protocol = policy.protocolOf({ ...grant, upstream });
    // Then no supported destination is selected.
    expect(protocol).toBeNull();
  });

  it.each([
    { format: 'responses', extra: { input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,eA==', file_url: REMOTE }] }] } },
    { format: 'chat', extra: { messages: [{ role: 'user', content: [{ type: 'file', file: { file_data: 'data:text/plain;base64,eA==', file_url: REMOTE } }] }] } },
    { format: 'messages', extra: { messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'text/plain', data: 'eA==', url: REMOTE } }] }] } },
    { format: 'chat', extra: { messages: [{ role: 'assistant', tool_calls: [{ type: 'mcp', server_url: REMOTE }] }] } },
    { format: 'responses', extra: { input: [{ type: 'function_call', name: 'local', arguments: '{}', tools: [{ type: 'web_search' }] }] } },
    { format: 'messages', extra: { tool_choice: { type: 'auto', server_url: REMOTE } } },
    { format: 'responses', extra: { reasoning: { effort: 'low', tools: [{ type: 'web_search' }] } } },
    { format: 'responses', extra: { text: { format: { type: 'json_schema', name: 'result', schema: SCHEMA }, container: {} } } },
  ])('refuses unreviewed operational fields in $format: $extra', ({ format, extra }) => {
    // Given a valid inference body for this endpoint.
    const body = bodyOf(format);
    expect(policy.bodyAllowed(body, context(format))).toBe(true);
    // When operational content adds remote sources or unreviewed capability fields.
    const allowed = policy.bodyAllowed({ ...body, ...extra }, context(format));
    // Then the policy fails closed at the operational node.
    expect(allowed).toBe(false);
  });

  it.each(['responses', 'chat', 'messages'])('preserves inert schemas and inline content in %s', (format) => {
    // Given inline media and an application schema containing operational-looking names.
    const inline = format === 'responses' ? { type: 'input_image', image_url: 'data:image/png;base64,eA==' }
      : format === 'chat' ? { type: 'file', file: { filename: 'local.txt', file_data: 'data:text/plain;base64,eA==' } }
        : { type: 'document', source: { type: 'base64', media_type: 'text/plain', data: 'eA==' } };
    const tools = format === 'responses' ? [{ type: 'function', name: 'local', parameters: SCHEMA }]
      : format === 'chat' ? [{ type: 'function', function: { name: 'local', parameters: SCHEMA } }]
        : [{ name: 'local', input_schema: SCHEMA }];
    const input = [{ role: 'user', content: [inline] }];
    // When local data crosses the structural policy.
    const allowed = policy.bodyAllowed({ ...bodyOf(format), [format === 'responses' ? 'input' : 'messages']: input, tools }, context(format));
    // Then schema properties remain inert and inline content needs no provider fetch.
    expect(allowed).toBe(true);
  });
});
