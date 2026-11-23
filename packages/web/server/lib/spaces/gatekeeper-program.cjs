'use strict';

// allow: SIZE_OK: The installed gatekeeper is a single standard-library-only script, including
// the policy the host imports. Its standalone dependency contract is regression-tested.

// The program of the gatekeeper container: the space's only way out.
//
// It runs on the Node of the base image, with nothing but the standard library, and it is
// delivered over `exec` on stdin into the container's tmpfs. Nothing about it is written to
// disk on the host side of a space, and it holds every secret in memory only.
//
// Three listeners:
//   corridor  an HTTP CONNECT proxy for the space, on the space-facing interface
//   window    a reverse proxy that adds a secret the space never sees, on the same interface
//   control   the host's channel, on the gatekeeper's own loopback, which the space cannot reach
//
// Arguments: <space-facing bind host> <corridor port> <window port> <control port>
// [<window deadline in ms>]. They are arguments so that the container command and the tests run
// the very same program; the last one lets a test watch a deadline pass without waiting five
// minutes for it. None of them changes a decision this program makes. The bind host is an
// address, or the path of a file that holds one: the container command names the file, and the
// host writes the gatekeeper's own address on the space's network into it before the program,
// because the host knows that address and this program has no say in where it listens.
//
// Everything the space sends is hostile input. Nothing it can send may end the process:
// a crash of the gatekeeper is a denial of service the agent could trigger at will.

const { Buffer } = require('node:buffer');
const dns = require('node:dns');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
// The host imports this same policy through the exports at the end. The installed script
// remains standalone and depends only on Node's standard library.
function createApprovalPolicy() {
  // Operational nodes come from JSON.parse in the installed program, or the host's
  // decoded grant. Keep these guards private: the script cannot import shared/guards.js
  // or Zod. The shared string guard accepts boxed strings; JSON text must be primitive.
  // valueOf checks the built-in string brand without coercing other values to text.
  const jsonString = (value) => {
    try {
      return Object.prototype.toString.call(value) === '[object String]' && String.prototype.valueOf.call(value) === value;
    } catch { return false; }
  };
  const jsonObject = (value) => Object.prototype.toString.call(value) === '[object Object]'
    && Object.getPrototypeOf(value) === Object.prototype;
  const purpose = 'pr-fix-loop-approval';
  const protocols = new Map([
    ['openai|https://api.openai.com/v1|authorization', 'openai'],
    ['openai|https://chatgpt.com/backend-api/codex|authorization', 'codex'],
    ['anthropic|https://api.anthropic.com/v1|x-api-key', 'anthropic'],
    ...['api.githubcopilot.com', 'api.individual.githubcopilot.com', 'api.business.githubcopilot.com', 'api.enterprise.githubcopilot.com']
      .map((host) => [`github-copilot|https://${host}|authorization`, 'copilot']),
  ]);
  const loginMethods = new Set([
    'openai/chatgpt-token-sharing', 'openai/chatgpt-browser', 'openai/chatgpt-headless', 'github-copilot/device',
  ]);
  // Reviewed model IDs and endpoint formats, not a name-prefix heuristic. Search and unknown
  // models stay excluded even when the caller omits every explicit hosted-tool option.
  const reviewedModels = new Map([
    ['openai/gpt-4.1', ['openai:responses', 'openai:chat']],
    ['openai/gpt-5.3-codex', ['openai:responses', 'codex:responses']],
    ['openai/gpt-5.4', ['openai:responses', 'openai:chat', 'codex:responses']],
    ['openai/gpt-6-luna', ['openai:responses', 'codex:responses']],
    ['anthropic/claude-opus-4-6', ['anthropic:messages']],
    ['anthropic/claude-sonnet-4-6', ['anthropic:messages']],
    ['github-copilot/gpt-5.3-codex', ['copilot:responses']],
    ['github-copilot/gpt-5.4', ['copilot:responses', 'copilot:chat']],
  ]);
  const reviewedModel = (model) => model && reviewedModels.get(`${model.providerID}/${model.modelID}`);
  const supportsProtocol = (protocol, model) => Boolean(reviewedModel(model)?.some((entry) => entry.startsWith(`${protocol}:`)));
  const protocolOf = ({ id, upstream, header }) => {
    // Match the spelling too: credentials, queries, ports and encoded paths cannot normalize
    // into a different destination after this check.
    if (!jsonString(upstream)) return null;
    return protocols.get(`${id}|${upstream.replace(/\/$/, '')}|${header}`) ?? null;
  };
  const networkAllowed = (network) => network.mode === 'allowlist'
    && Array.isArray(network.domains) && network.domains.length === 0;
  const grantAllowed = (grant) => {
    if (grant.id !== grant.provider) return false;
    switch (grant.kind) {
      case 'model': return protocolOf(grant) !== null;
      case 'login': return loginMethods.has(`${grant.provider}/${grant.method}`);
      default: return false;
    }
  };
  const requestAllowed = (protocol, { method, rest, model }) => {
    if (!supportsProtocol(protocol, model)) return false;
    if (method === 'GET') return rest === '/models' && ['openai', 'anthropic', 'copilot'].includes(protocol);
    if (method !== 'POST') return false;
    if (!reviewedModel(model).includes(`${protocol}:${formatOf(rest)}`)) return false;
    switch (protocol) {
      case 'openai': return ['/responses', '/responses/compact', '/chat/completions'].includes(rest);
      case 'codex': return ['/responses', '/responses/compact'].includes(rest);
      case 'anthropic': return ['/messages', '/messages/count_tokens'].includes(rest);
      case 'copilot': return ['/responses', '/chat/completions', '/messages'].includes(rest);
      default: return false;
    }
  };
  const fieldsOf = (text) => new Set(text.split(' '));
  const fieldsAllowed = (value, fields) => jsonObject(value) && Object.keys(value).every((key) => fields.has(key));
  const sharedFields = 'model tools tool_choice stream temperature top_p metadata service_tier';
  const bodyFields = {
    responses: fieldsOf(`${sharedFields} input instructions parallel_tool_calls stream_options max_output_tokens max_tool_calls reasoning text truncation store background include prompt_cache_key prompt_cache_retention safety_identifier user`),
    chat: fieldsOf(`${sharedFields} messages functions function_call parallel_tool_calls stream_options max_tokens max_completion_tokens stop presence_penalty frequency_penalty logit_bias logprobs top_logprobs seed user store reasoning_effort verbosity response_format prediction prompt_cache_key prompt_cache_retention safety_identifier`),
    messages: fieldsOf(`${sharedFields} messages system max_tokens stop_sequences top_k thinking output_config betas`),
  };
  const formatOf = (rest) => rest === '/chat/completions' ? 'chat' : rest.startsWith('/messages') ? 'messages' : 'responses';
  const functionFields = fieldsOf('name description parameters strict');
  const toolFields = {
    responses: fieldsOf('type name description parameters strict format'),
    messages: fieldsOf('type name description input_schema cache_control'),
  };
  const localTool = (tool, format) => {
    if (!jsonObject(tool)) return false;
    switch (format) {
      case 'chat': return fieldsAllowed(tool, fieldsOf('type function')) && tool.type === 'function' && fieldsAllowed(tool.function, functionFields) && jsonString(tool.function.name);
      case 'messages': return fieldsAllowed(tool, toolFields.messages) && [undefined, 'custom'].includes(tool.type) && jsonString(tool.name) && jsonObject(tool.input_schema);
      case 'responses': return fieldsAllowed(tool, toolFields.responses) && ['function', 'custom'].includes(tool.type) && jsonString(tool.name);
      default: return false;
    }
  };
  // Only operational protocol nodes are interpreted. Function schemas, tool inputs/outputs,
  // metadata and text are inert data, even when they contain names such as container or tools.
  const contentFields = Object.fromEntries(Object.entries({
    text: 'type text cache_control citations', input_text: 'type text', output_text: 'type text annotations logprobs',
    summary_text: 'type text', reasoning_text: 'type text', input_image: 'type image_url detail', image_url: 'type image_url',
    input_file: 'type filename file_data', file: 'type file', input_audio: 'type input_audio',
    image: 'type source cache_control', document: 'type source title context citations cache_control',
    thinking: 'type thinking signature', redacted_thinking: 'type data',
    tool_use: 'type id name input cache_control', tool_result: 'type tool_use_id content is_error cache_control',
  }).map(([type, fields]) => [type, fieldsOf(fields)]));
  const partsAllowed = (content, format) => jsonString(content) || (Array.isArray(content) && content.every((part) => {
    if (!jsonObject(part) || !Object.hasOwn(contentFields, part.type) || !fieldsAllowed(part, contentFields[part.type])) return false;
    switch (part.type) {
      case 'text': case 'input_text': case 'output_text': case 'summary_text': case 'reasoning_text': return jsonString(part.text);
      case 'input_image': return jsonString(part.image_url) && part.image_url.startsWith('data:');
      case 'image_url': return fieldsAllowed(part.image_url, fieldsOf('url detail')) && jsonString(part.image_url.url) && part.image_url.url.startsWith('data:');
      case 'input_file': return jsonString(part.file_data);
      case 'file': return fieldsAllowed(part.file, fieldsOf('filename file_data')) && jsonString(part.file.file_data);
      case 'input_audio': return fieldsAllowed(part.input_audio, fieldsOf('data format')) && jsonString(part.input_audio.data);
      case 'image': case 'document': return fieldsAllowed(part.source, fieldsOf('type media_type data')) && part.source.type === 'base64' && jsonString(part.source.data);
      case 'thinking': return jsonString(part.thinking);
      case 'redacted_thinking': return jsonString(part.data);
      case 'tool_use': return format === 'messages' && jsonString(part.name) && jsonObject(part.input);
      case 'tool_result': return format === 'messages' && partsAllowed(part.content, format);
      default: return false;
    }
  }));
  const callFields = fieldsOf('name arguments');
  const chatCallsAllowed = (calls) => Array.isArray(calls) && calls.every((call) => fieldsAllowed(call, fieldsOf('id type function')) && call.type === 'function' && fieldsAllowed(call.function, callFields));
  const messageFields = {
    responses: fieldsOf('type id role content status'),
    chat: fieldsOf('role content name tool_calls tool_call_id function_call refusal'),
    messages: fieldsOf('role content'),
  };
  const inputAllowed = (input, format) => {
    if (jsonString(input)) return format === 'responses';
    return Array.isArray(input) && input.every((item) => {
      if (!jsonObject(item)) return false;
      switch (item.type) {
        case undefined: case 'message': return fieldsAllowed(item, messageFields[format]) && partsAllowed(item.content ?? '', format)
          && (item.tool_calls === undefined || chatCallsAllowed(item.tool_calls))
          && (item.function_call === undefined || fieldsAllowed(item.function_call, callFields));
        case 'function_call': case 'custom_tool_call': return format === 'responses' && fieldsAllowed(item, fieldsOf('type id call_id name arguments input status')) && jsonString(item.name);
        case 'function_call_output': case 'custom_tool_call_output': return format === 'responses' && fieldsAllowed(item, fieldsOf('type id call_id output status')) && (jsonString(item.output) || partsAllowed(item.output, format));
        case 'reasoning': return format === 'responses' && fieldsAllowed(item, fieldsOf('type id summary content encrypted_content status'))
          && (item.summary === undefined || partsAllowed(item.summary, format)) && (item.content === undefined || partsAllowed(item.content, format));
        default: return false;
      }
    });
  };
  const optionFields = Object.fromEntries(Object.entries({
    reasoning: 'effort summary generate_summary', stream_options: 'include_usage include_obfuscation',
    text: 'format verbosity', response_format: 'type json_schema', thinking: 'type budget_tokens display',
    output_config: 'effort format', prediction: 'type content',
  }).map(([name, fields]) => [name, fieldsOf(fields)]));
  const outputFormatAllowed = (value) => fieldsAllowed(value, fieldsOf('type name description schema strict')) && ['text', 'json_object', 'json_schema'].includes(value.type);
  const bodyAllowed = (body, { protocol, rest, model }) => {
    const format = formatOf(rest);
    if (!fieldsAllowed(body, bodyFields[format])) return false;
    if (!reviewedModel(model)?.includes(`${protocol}:${format}`) || body.model !== model.modelID) return false;
    if ((body.store !== undefined && body.store !== false) || (body.background !== undefined && body.background !== false)) return false;
    for (const [name, fields] of Object.entries(optionFields)) {
      if (body[name] !== undefined && !fieldsAllowed(body[name], fields)) return false;
    }
    if (body.text?.format !== undefined && !outputFormatAllowed(body.text.format)) return false;
    if (body.output_config?.format !== undefined && !outputFormatAllowed(body.output_config.format)) return false;
    if (body.response_format !== undefined && (!['text', 'json_object', 'json_schema'].includes(body.response_format.type)
      || (body.response_format.json_schema !== undefined && !fieldsAllowed(body.response_format.json_schema, fieldsOf('name description schema strict'))))) return false;
    if (body.prediction !== undefined && (body.prediction.type !== 'content' || !partsAllowed(body.prediction.content, format))) return false;
    if (body.tools !== undefined && (!Array.isArray(body.tools) || !body.tools.every((tool) => localTool(tool, format)))) return false;
    if (body.functions !== undefined && (!Array.isArray(body.functions) || !body.functions.every((tool) => fieldsAllowed(tool, functionFields)))) return false;
    if (jsonObject(body.tool_choice)) {
      const choices = format === 'messages' ? ['auto', 'any', 'none', 'tool'] : ['function', 'custom'];
      if (!fieldsAllowed(body.tool_choice, fieldsOf('type name function disable_parallel_tool_use')) || !choices.includes(body.tool_choice.type)) return false;
      if (body.tool_choice.function !== undefined && !fieldsAllowed(body.tool_choice.function, fieldsOf('name'))) return false;
    } else if (body.tool_choice !== undefined && !['auto', 'none', 'required'].includes(body.tool_choice)) return false;
    if (body.function_call !== undefined && !['auto', 'none'].includes(body.function_call) && !fieldsAllowed(body.function_call, fieldsOf('name'))) return false;
    if (body.include !== undefined && (!Array.isArray(body.include) || !body.include.every((value) => value === 'reasoning.encrypted_content'))) return false;
    if (body.system !== undefined && !partsAllowed(body.system, format)) return false;
    return inputAllowed(format === 'responses' ? body.input : body.messages, format);
  };
  return { purpose, protocolOf, networkAllowed, grantAllowed, requestAllowed, bodyAllowed, reviewedModel, supportsProtocol };
}
const approval = createApprovalPolicy();
// The trusted host prelude sets this module field from immutable runtime labels at
// every start. Capture it once; neither requests nor later exports can change it.
const protectedApproval = module.exports.spacePurpose === approval.purpose;

const [bindArgument, corridorPort, windowPort, controlPort, windowDeadline, corridorCap, windowCap, controlCap, bodyMaximum, bodyTotal, bodyDeadline, bodyTokens, bodyDepth] = process.argv.slice(2);

const cap = (given, production) => (Number.isInteger(Number(given)) && Number(given) > 0 ? Number(given) : production);
const CONTROL_HOST = '127.0.0.1';

const ALLOWED_PORT = 443;
const ALWAYS_REFUSED = ['auth.openai.com'];

const MAX_TUNNELS = 64;
const MAX_CORRIDOR_CONNECTIONS = cap(corridorCap, 2 * MAX_TUNNELS);
const MAX_WINDOW_CONNECTIONS = cap(windowCap, 64);
const WINDOW_IDLE_MS = Number(windowDeadline) > 0 ? Number(windowDeadline) : 300_000;
const MAX_CONTROL_CONNECTIONS = cap(controlCap, 8);
const NOTE_INTERVAL_MS = 60_000;
const TUNNEL_IDLE_MS = 300_000;
const CONNECT_TIMEOUT_MS = 15_000;

const MAX_HEADER_BYTES = 16 * 1024;
const HEADERS_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 60_000;
const CONTROL_BODY_BYTES = 1024 * 1024;

// Two full body reservations fit under the gatekeeper's 256 MiB limit with room for UTF-8
// decoding, one synchronous JSON parse, bounded objects, sockets and the upstream write.
function createApprovalBodies({ maximum = 4 * 1024 * 1024, total = 8 * 1024 * 1024, deadline = 30000, tokens = 16384, depth = 32 } = {}) {
  const state = { active: 0, reservedBytes: 0, bufferedBytes: 0, peakReservedBytes: 0, peakBufferedBytes: 0, parses: 0 };
  const structureFits = (text) => {
    let nesting = 0;
    let count = 0;
    let quoted = false;
    let escaped = false;
    for (const character of text) {
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') { quoted = true; count += 1; }
      else if (character === '{' || character === '[') { nesting += 1; count += 1; }
      else if (character === '}' || character === ']') nesting -= 1;
      else if (character === ',' || character === ':') count += 1;
      if (nesting > depth || count > tokens) return false;
    }
    return true;
  };
  const acquire = () => {
    if (state.reservedBytes + maximum > total) return null;
    state.active += 1;
    state.reservedBytes += maximum;
    state.peakReservedBytes = Math.max(state.peakReservedBytes, state.reservedBytes);
    let released = false;
    // A fixed byte buffer also bounds per-chunk overhead when the sender fragments its upload.
    let buffer = Buffer.allocUnsafe(maximum);
    let retained = 0;
    let cancelRead = () => {};
    const clear = () => { state.bufferedBytes -= retained; retained = 0; buffer = null; };
    const release = () => {
      if (released) return;
      released = true;
      clear();
      state.active -= 1;
      state.reservedBytes -= maximum;
      cancelRead();
    };
    const read = (request) => new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        request.removeListener('data', data);
        request.removeListener('end', end);
        request.removeListener('aborted', abort);
        request.removeListener('error', abort);
        cancelRead = () => {};
        clear();
        if (result.error) { request.pause(); release(); }
        resolve(result);
      };
      const data = (chunk) => {
        if (retained + chunk.length > maximum) { finish({ error: 'size' }); return; }
        chunk.copy(buffer, retained);
        retained += chunk.length;
        state.bufferedBytes += chunk.length;
        state.peakBufferedBytes = Math.max(state.peakBufferedBytes, state.bufferedBytes);
      };
      const end = () => {
        const text = buffer.toString('utf8', 0, retained);
        clear();
        if (!structureFits(text)) { finish({ error: 'structure' }); return; }
        try {
          state.parses += 1;
          const body = JSON.parse(text);
          // Forward the value this parser validates. Repeated JSON keys must not let an
          // upstream parser choose a different model, tool declaration or content source.
          const canonical = JSON.stringify(body);
          if (Buffer.byteLength(canonical) > maximum) { finish({ error: 'size' }); return; }
          finish({ text: canonical, body });
        } catch { finish({ error: 'json' }); }
      };
      const abort = () => finish({ error: 'aborted' });
      const timer = setTimeout(() => finish({ error: 'deadline' }), deadline);
      cancelRead = abort;
      request.on('data', data);
      request.once('end', end);
      request.once('aborted', abort);
      request.once('error', abort);
    });
    return { read, release };
  };
  return { acquire, inspect: () => ({ ...state }) };
}
const approvalBodies = createApprovalBodies({
  maximum: cap(bodyMaximum, 4 * 1024 * 1024), total: cap(bodyTotal, 8 * 1024 * 1024),
  deadline: cap(bodyDeadline, 30000), tokens: cap(bodyTokens, 16384), depth: cap(bodyDepth, 32),
});

// The journal is small on purpose: it is a record of attempts, not a log.
const JOURNAL_RECORDS = 500;
const MAX_JOURNAL_HOST = 256;
const MAX_JOURNAL_DECISION = 64;
const MAX_ALLOWED_DOMAINS = 500;

const DOMAIN_PATTERN = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const NUMERIC_LABEL = /^(\d+|0x[0-9a-f]+)$/;
const GRANT_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const HEADER_NAME_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const MAX_SECRET_LENGTH = 8192;
const MAX_GRANT_HEADERS = 32;
const HEADER_VALUE_PATTERN = /^[\t\x20-\x7e\x80-\xff]+$/;
const RESERVED_HEADER_NAMES = ['host', 'content-length', 'transfer-encoding', 'connection', 'te', 'upgrade', 'keep-alive', 'proxy-connection', 'authorization', 'x-api-key', 'proxy-authorization'];

function readBindHost(argument) {
  const given = String(argument ?? '');
  let text = given;
  if (given.startsWith('/')) {
    try {
      text = fs.readFileSync(given, 'utf8').trim();
    } catch (error) {
      console.error(`gatekeeper: cannot read the bind address from ${given} (${error.code || error.message})`);
      process.exit(2);
    }
  }
  if (net.isIP(text) === 0 || text === '0.0.0.0' || text === '::') {
    console.error(`gatekeeper: ${given} is not the address of one interface`);
    process.exit(2);
  }
  return text;
}
let networkMode = 'allowlist';
let allowedDomains = new Set();
const grants = new Map();
let approvalModel = null;

const STARTED_AT = new Date().toISOString();
const journal = [];
let journalDropped = 0;

function record(listener, host, port, decision) {
  journal.push({
    at: new Date().toISOString(),
    listener,
    host: String(host || '').slice(0, MAX_JOURNAL_HOST),
    port: Number(port) || 0,
    decision: String(decision).slice(0, MAX_JOURNAL_DECISION),
  });
  if (journal.length > JOURNAL_RECORDS) {
    journal.shift();
    journalDropped += 1;
  }
}


function parseIPv4(text) {
  const parts = String(text).split('.');
  if (parts.length !== 4) return null;
  const bytes = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes.push(value);
  }
  return bytes;
}

function parseIPv6(text) {
  const address = String(text).split('%')[0];
  if (!address.includes(':')) return null;
  const [head, tail, ...rest] = address.split('::');
  if (rest.length > 0) return null;
  const readGroups = (part) => {
    if (part === undefined || part === '') return [];
    const groups = [];
    const pieces = part.split(':');
    for (let index = 0; index < pieces.length; index += 1) {
      const piece = pieces[index];
      if (index === pieces.length - 1 && piece.includes('.')) {
        const embedded = parseIPv4(piece);
        if (!embedded) return null;
        groups.push(embedded[0] * 256 + embedded[1], embedded[2] * 256 + embedded[3]);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null;
      groups.push(Number.parseInt(piece, 16));
    }
    return groups;
  };
  const left = readGroups(head);
  const right = tail === undefined ? [] : readGroups(tail);
  if (left === null || right === null) return null;
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? missing !== 0 : missing < 0) return null;
  const groups = [...left, ...new Array(tail === undefined ? 0 : missing).fill(0), ...right];
  if (groups.length !== 8) return null;
  const bytes = [];
  for (const group of groups) bytes.push((group >> 8) & 0xff, group & 0xff);
  return bytes;
}

function blockedIPv4(bytes) {
  const [a, b, c] = bytes;
  return a === 0
    || a === 10
    || (a === 100 && b >= 64 && b <= 127)
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224;
}

function embeddedIPv4(bytes) {
  const zeros = (from, to) => bytes.slice(from, to).every((byte) => byte === 0);
  if (zeros(0, 10) && ((bytes[10] === 0xff && bytes[11] === 0xff) || (bytes[10] === 0 && bytes[11] === 0 && !zeros(12, 16)))) {
    return bytes.slice(12, 16);
  }
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && zeros(4, 12)) {
    return bytes.slice(12, 16);
  }
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    return bytes.slice(2, 6);
  }
  return null;
}

function blockedIPv6(bytes) {
  const embedded = embeddedIPv4(bytes);
  if (embedded) return blockedIPv4(embedded);
  if (bytes.every((byte) => byte === 0)) return true;
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return true;
  if ((bytes[0] & 0xfe) === 0xfc) return true;
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true;
  if (bytes[0] === 0xff) return true;
  return false;
}

function isBlockedAddress(text) {
  const v4 = parseIPv4(text);
  if (v4) return blockedIPv4(v4);
  const v6 = parseIPv6(text);
  if (v6) return blockedIPv6(v6);
  return true;
}

const lookupAll = (host) => new Promise((resolve) => {
  dns.lookup(host, { all: true, verbatim: true }, (error, answers) => {
    if (error || !Array.isArray(answers) || answers.length === 0) {
      resolve({ addresses: [], reason: error ? String(error.code || error.message) : 'no address' });
      return;
    }
    resolve({ addresses: answers, reason: '' });
  });
});

const chooseAddress = (addresses) => addresses.find((answer) => answer.family === 4) ?? addresses[0];

async function resolveAllowedAddress(host) {
  const { addresses, reason } = await lookupAll(host);
  if (addresses.length === 0) return { error: `unresolved:${reason}` };
  if (addresses.some((answer) => isBlockedAddress(answer.address))) return { error: 'blocked-address' };
  const chosen = chooseAddress(addresses);
  return { address: chosen.address, family: chosen.family };
}

const fixedLookup = (address, family) => (hostname, options, callback) => {
  if (options && options.all) callback(null, [{ address, family }]);
  else callback(null, address, family);
};


function splitTarget(text) {
  const value = String(text || '');
  const separator = value.lastIndexOf(':');
  if (separator <= 0) return null;
  const port = Number(value.slice(separator + 1));
  let host = value.slice(0, separator);
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || host.length === 0 || host.length > 255) return null;
  if (/[\s/@]/.test(host)) return null;
  return { host, port };
}

const normalizeName = (host) => String(host).trim().toLowerCase().replace(/\.$/, '');

function refuseTarget(host, port) {
  if (protectedApproval) return 'deny:approval-profile';
  const name = normalizeName(host);
  if (ALWAYS_REFUSED.includes(name)) return 'deny:always-refused';
  if (parseIPv4(name) || parseIPv6(name) || !isDomainName(name)) return 'deny:not-a-name';
  if (port !== ALLOWED_PORT) return 'deny:port';
  if (networkMode === 'open') return null;
  return allowedDomains.has(name) ? null : 'deny:not-on-allowlist';
}

const isDomainName = (name) => DOMAIN_PATTERN.test(name) && !NUMERIC_LABEL.test(name.slice(name.lastIndexOf('.') + 1));

let openTunnels = 0;

const MAX_LINGERING_REFUSALS = 16;
const lingeringRefusals = new Set();

const REFUSED = 'refused';
const UNREACHABLE = 'unreachable';

function refuse(socket, status, text, reason) {
  try {
    socket.end(`HTTP/1.1 ${status} ${text}\r\nx-gatekeeper-reason: ${reason}\r\nConnection: close\r\n\r\n`);
    socket.resume();
    const release = () => { lingeringRefusals.delete(socket); if (!socket.destroyed) socket.destroySoon(); };
    lingeringRefusals.add(socket);
    socket.on('close', () => lingeringRefusals.delete(socket));
    socket.on('error', release);
    socket.on('end', release);
    while (lingeringRefusals.size > MAX_LINGERING_REFUSALS) {
      const oldest = lingeringRefusals.values().next().value;
      lingeringRefusals.delete(oldest);
      oldest.destroy();
    }
  } catch {
    socket.destroy();
  }
}

async function openTunnel(request, clientSocket, head) {
  clientSocket.on('error', () => {});
  let release = () => {};
  const clientLeft = () => release();
  clientSocket.on('close', clientLeft);
  clientSocket.on('end', clientLeft);

  const target = splitTarget(request.url);
  if (!target) {
    record('corridor', '', 0, 'deny:malformed');
    refuse(clientSocket, 400, 'Bad Request', REFUSED);
    return;
  }
  const { host, port } = target;
  const refusal = refuseTarget(host, port);
  if (refusal) {
    record('corridor', normalizeName(host), port, refusal);
    refuse(clientSocket, 403, 'Forbidden', REFUSED);
    return;
  }
  if (openTunnels >= MAX_TUNNELS) {
    record('corridor', normalizeName(host), port, 'deny:too-many-tunnels');
    refuse(clientSocket, 503, 'Service Unavailable', REFUSED);
    return;
  }
  openTunnels += 1;
  let counted = true;
  const releasePlace = () => {
    if (counted) {
      counted = false;
      openTunnels -= 1;
    }
  };
  release = releasePlace;

  const resolved = await resolveAllowedAddress(normalizeName(host));
  if (resolved.error) {
    releasePlace();
    record('corridor', normalizeName(host), port, `deny:${resolved.error}`);
    refuse(clientSocket, 403, 'Forbidden', REFUSED);
    return;
  }
  record('corridor', normalizeName(host), port, 'allow');

  const upstream = net.connect({ host: resolved.address, port, allowHalfOpen: true });
  const abort = () => {
    releasePlace();
    upstream.destroy();
    clientSocket.destroy();
  };
  let carrying = false;
  upstream.on('error', (error) => {
    const code = String(error.code || 'error').slice(0, 32);
    record('corridor', normalizeName(host), port, `failed:${code}`);
    if (!carrying && !clientSocket.destroyed && !clientSocket.writableEnded) {
      refuse(clientSocket, 502, 'Bad Gateway', UNREACHABLE);
      releasePlace();
      upstream.destroy();
      return;
    }
    abort();
  });
  upstream.setTimeout(CONNECT_TIMEOUT_MS, abort);
  upstream.on('connect', () => {
    upstream.setTimeout(TUNNEL_IDLE_MS, abort);
    clientSocket.setTimeout(TUNNEL_IDLE_MS, abort);
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length > 0) upstream.write(head);
    carrying = true;
    release = () => {};
    joinSockets(clientSocket, upstream, releasePlace);
  });
  release = abort;
  if (clientSocket.destroyed || clientSocket.readableEnded) abort();
}

function joinSockets(clientSocket, upstream, done) {
  let closed = 0;
  const bothGone = () => {
    closed += 1;
    if (closed >= 2) done();
  };
  const follow = (peer) => () => {
    if (!peer.destroyed) peer.destroySoon();
    bothGone();
  };
  upstream.on('close', follow(clientSocket));
  clientSocket.on('close', follow(upstream));
  upstream.pipe(clientSocket);
  clientSocket.pipe(upstream);
}

function refusePlainProxy(request, response) {
  let host = '';
  try {
    host = normalizeName(new URL(request.url).hostname);
  } catch {
    host = '';
  }
  record('corridor', host, 0, 'deny:not-connect');
  response.writeHead(403, { 'content-type': 'application/json' });
  response.end('{"error":"the corridor takes CONNECT only"}');
}


const WINDOW_PATH = /^\/model\/([A-Za-z0-9._-]{1,64})([/?][^]*)?$/;

function walksOutOfGrant(rest) {
  let form = String(rest ?? '');
  for (;;) {
    if (form.split(/[/\\;?#]/).includes('..')) return true;
    if (!form.includes('%')) return false;
    let decoded;
    try {
      decoded = decodeURIComponent(form);
    } catch {
      return true;
    }
    if (decoded === form) return false;
    form = decoded;
  }
}

const agentOptions = { keepAlive: false, maxSockets: MAX_WINDOW_CONNECTIONS, maxTotalSockets: MAX_WINDOW_CONNECTIONS };
const windowAgents = { 'http:': new http.Agent(agentOptions), 'https:': new https.Agent(agentOptions) };

const answerJson = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};

const ownListenerPorts = new Set([Number(corridorPort), Number(windowPort), Number(controlPort)]);
const ownAddresses = new Set(Object.values(os.networkInterfaces())
  .flat()
  .filter(Boolean)
  .map((entry) => String(entry.address).toLowerCase()));

function isLoopback(address) {
  const v4 = parseIPv4(address);
  if (v4) return v4[0] === 127;
  const v6 = parseIPv6(address);
  if (!v6) return false;
  const embedded = embeddedIPv4(v6);
  if (embedded) return embedded[0] === 127;
  return v6.slice(0, 15).every((byte) => byte === 0) && v6[15] === 1;
}

const isOwnListener = (address, port) => (isLoopback(address) || ownAddresses.has(String(address).toLowerCase())) && ownListenerPorts.has(Number(port));

async function serveWindow(request, response) {
  request.on('error', () => {});
  let reservation = null;
  let outgoing = null;
  response.once('close', () => {
    if (outgoing) {
      if (protectedApproval || !response.writableFinished) outgoing.destroy();
    } else reservation?.release();
  });
  try {
  const match = WINDOW_PATH.exec(request.url || '');
  if (match && walksOutOfGrant(match[2] || '')) {
    record('window', 'grant-path', 0, 'deny:path-walks-out');
    answerJson(response, 403, { error: 'no such grant' });
    return;
  }
  const grant = match ? grants.get(match[1]) : null;
  if (!grant) {
    record('window', 'unknown-grant', 0, 'deny:no-grant');
    answerJson(response, 403, { error: 'no such grant' });
    return;
  }

  let modelBody = null;
  if (protectedApproval) {
    if (!approval.requestAllowed(grant.protocol, { method: request.method, rest: match[2] || '', model: grant.model }) || request.headers.upgrade) {
      record('window', 'model-protocol', 0, 'deny:model-protocol');
      answerJson(response, 403, { error: 'refused model request' });
      return;
    }
    if (request.method === 'POST') {
      reservation = approvalBodies.acquire();
      if (!reservation) {
        record('window', 'model-protocol', 0, 'deny:model-body-budget');
        response.setHeader('connection', 'close');
        answerJson(response, 503, { error: 'model body capacity is full' });
        return;
      }
      const received = await reservation.read(request);
      if (response.destroyed) return;
      if (received.error) {
        record('window', 'model-protocol', 0, `deny:model-body-${received.error}`);
        response.setHeader('connection', 'close');
        const status = received.error === 'deadline' ? 408 : received.error === 'json' ? 403 : 413;
        answerJson(response, status, { error: 'refused model body' });
        return;
      }
      if (!approval.bodyAllowed(received.body, { protocol: grant.protocol, rest: match[2] || '', model: grant.model })) {
        record('window', 'model-protocol', 0, 'deny:model-body');
        answerJson(response, 403, { error: 'refused model request' });
        return;
      }
      modelBody = received.text;
    }
  }

  const upstream = new URL(grant.upstream);
  const port = Number(upstream.port || (upstream.protocol === 'https:' ? 443 : 80));
  if (ALWAYS_REFUSED.includes(normalizeName(upstream.hostname))) {
    record('window', normalizeName(upstream.hostname), port, 'deny:always-refused');
    answerJson(response, 403, { error: 'refused destination' });
    return;
  }
  const resolved = await lookupAll(upstream.hostname);
  if (response.destroyed) return;
  if (resolved.addresses.length === 0) {
    record('window', normalizeName(upstream.hostname), port, `deny:unresolved:${resolved.reason}`);
    answerJson(response, 502, { error: 'the upstream of this grant does not resolve' });
    return;
  }
  const chosen = chooseAddress(resolved.addresses);
  if (isOwnListener(chosen.address, port)) {
    record('window', normalizeName(upstream.hostname), port, 'deny:own-listener');
    answerJson(response, 403, { error: 'refused destination' });
    return;
  }

  // Whatever the space sent as credentials goes, and the grant's own header takes its place. A
  // grant without a secret, an opened domain, adds nothing: the upstream sees the request as the
  // space made it, less the credential headers. The grant's own extra headers are set last, over
  // whatever the space sent under their names (Node lowercases and joins incoming names, so the
  // names match), and the space can neither read nor override them.
  // A protected request cannot supply proxy routing or method-override headers. These are the
  // protocol headers used by the existing model/login paths; everything else stays inside.
  const modelHeaders = new Set(['accept', 'content-type', 'anthropic-version', 'anthropic-beta', 'chatgpt-account-id', 'openai-beta', 'session_id', 'conversation_id', 'originator', 'copilot-integration-id', 'editor-version', 'editor-plugin-version', 'openai-intent', 'x-initiator', 'x-request-id']);
  const headers = protectedApproval
    ? Object.fromEntries(Object.entries(request.headers).filter(([name]) => modelHeaders.has(name)))
    : { ...request.headers };
  if (protectedApproval) {
    headers['content-length'] = modelBody === null ? '0' : String(Buffer.byteLength(modelBody));
    if (modelBody !== null) headers['content-type'] = 'application/json';
  }
  for (const name of Object.keys(headers)) {
    const lower = name.toLowerCase();
    if (['authorization', 'x-api-key', 'x-goog-api-key', 'proxy-authorization'].includes(lower) || lower === grant.header) delete headers[name];
  }
  headers.host = upstream.host;
  if (grant.secret !== null) {
    headers[grant.header] = grant.header === 'authorization' ? `Bearer ${grant.secret}` : grant.secret;
  }
  Object.assign(headers, grant.headers);

  record('window', normalizeName(upstream.hostname), port, 'allow');
  const transport = upstream.protocol === 'https:' ? https : http;
  outgoing = transport.request({
    hostname: upstream.hostname,
    port,
    method: request.method,
    path: upstream.pathname.replace(/\/$/, '') + (match[2] || ''),
    headers,
    agent: windowAgents[upstream.protocol],
    lookup: fixedLookup(chosen.address, chosen.family),
  }, (answer) => {
    if (protectedApproval && answer.statusCode >= 300 && answer.statusCode < 400) {
      record('window', normalizeName(upstream.hostname), port, 'deny:model-redirect');
      answer.resume();
      answerJson(response, 502, { error: 'the model endpoint redirected' });
      return;
    }
    response.writeHead(answer.statusCode || 502, answer.headers);
    answer.on('error', () => { response.destroy(); });
    answer.pipe(response);
  });
  outgoing.once('close', () => reservation?.release());
  // The deadline covers the whole exchange, silence by silence. `given` keeps the record to one
  // per request: the destroy below makes the socket error, and that is this timeout, not news.
  let given = false;
  outgoing.setTimeout(WINDOW_IDLE_MS, () => {
    given = true;
    record('window', normalizeName(upstream.hostname), port, 'failed:timeout');
    if (!response.headersSent) answerJson(response, 504, { error: 'the upstream did not answer in time' });
    else response.destroy();
    outgoing.destroy();
  });
  outgoing.on('error', (error) => {
    if (given) return;
    given = true;
    const code = String(error.code || 'error').slice(0, 32);
    record('window', normalizeName(upstream.hostname), port, `failed:${code}`);
    if (!response.headersSent) answerJson(response, 502, { error: 'the upstream did not answer' });
    else response.destroy();
  });
  if (protectedApproval) outgoing.end(modelBody ?? undefined);
  else request.pipe(outgoing);
  } finally {
    if (!outgoing) reservation?.release();
  }
}


const readBody = (request, maximum = CONTROL_BODY_BYTES) => new Promise((resolve) => {
  let chunks = [];
  let bytes = 0;
  let tooLarge = false;
  request.on('data', (chunk) => {
    if (tooLarge) return;
    bytes += chunk.length;
    if (bytes > maximum) {
      tooLarge = true;
      chunks = [];
    } else chunks.push(chunk);
  });
  request.on('error', () => resolve(null));
  request.on('end', () => resolve(tooLarge ? null : Buffer.concat(chunks).toString('utf8')));
});

const asText = (value) => (value === null || value === undefined || value instanceof Object ? '' : String(value));

function setNetwork(body) {
  if (protectedApproval && !approval.networkAllowed(body)) return 'approval profile requires an empty allowlist';
  if (body.mode !== 'allowlist' && body.mode !== 'open') return 'mode is "allowlist" or "open"';
  const domains = Array.isArray(body.domains) ? body.domains : [];
  if (domains.length > MAX_ALLOWED_DOMAINS) return `at most ${MAX_ALLOWED_DOMAINS} domains`;
  const names = domains.map((domain) => normalizeName(asText(domain)));
  const wrong = names.find((name) => !isDomainName(name) || parseIPv4(name) || parseIPv6(name));
  if (wrong !== undefined) return `'${wrong}' is not a domain name. The allowlist holds exact names, no wildcards and no addresses.`;
  networkMode = body.mode;
  allowedDomains = new Set(names);
  return null;
}

function grantHeadersOf(value) {
  if (value === undefined) return { headers: {} };
  if (value === null || !(value instanceof Object) || Array.isArray(value)) return { refusal: 'the headers of a grant are an object of names to text' };
  const entries = Object.entries(value);
  if (entries.length > MAX_GRANT_HEADERS) return { refusal: `at most ${MAX_GRANT_HEADERS} headers on a grant` };
  const headers = {};
  for (const [name, text] of entries) {
    const lower = name.toLowerCase();
    if (!HEADER_NAME_PATTERN.test(lower)) return { refusal: 'a header name is 1 to 64 letters, digits or dashes' };
    if (RESERVED_HEADER_NAMES.includes(lower)) return { refusal: `the header '${lower}' is the window's own` };
    const asString = asText(text);
    if (asString.length === 0 || asString.length > MAX_SECRET_LENGTH) return { refusal: 'a header of a grant is text, 1 to 8192 characters' };
    if (!HEADER_VALUE_PATTERN.test(asString)) return { refusal: 'a header of a grant is Latin-1 text without line breaks' };
    headers[lower] = asString;
  }
  return { headers };
}

function addGrant(body) {
  const id = asText(body.id);
  if (!GRANT_ID_PATTERN.test(id)) return 'a grant id is 1 to 64 letters, digits, dots, dashes or underscores';
  const withSecret = body.secret !== undefined || body.header !== undefined;
  const header = withSecret ? asText(body.header).toLowerCase() : null;
  const secret = withSecret ? asText(body.secret) : null;
  if (withSecret && !HEADER_NAME_PATTERN.test(header)) return 'a header name is 1 to 64 letters, digits or dashes';
  if (withSecret && (secret.length === 0 || secret.length > MAX_SECRET_LENGTH)) return 'a grant with a header needs a secret';
  const extra = grantHeadersOf(body.headers);
  if (extra.refusal) return extra.refusal;
  if (header !== null && header in extra.headers) return `the header '${header}' carries the secret and cannot be set twice`;
  let upstream;
  try {
    upstream = new URL(asText(body.upstream));
  } catch {
    return 'the upstream of a grant is a URL';
  }
  if (upstream.protocol !== 'http:' && upstream.protocol !== 'https:') return 'the upstream of a grant is http or https';
  const protocol = approval.protocolOf({ id, upstream: asText(body.upstream), header });
  if (protectedApproval && (!protocol || !withSecret || Object.keys(extra.headers).length > 0)) return 'approval profile accepts supported model credentials only';
  if (protectedApproval && (body.model?.providerID !== id || !approval.supportsProtocol(protocol, body.model))) return 'approval profile requires the host-selected reviewed inference model';
  const model = protectedApproval ? { providerID: body.model.providerID, modelID: body.model.modelID } : null;
  if (protectedApproval) {
    if (approvalModel && (approvalModel.providerID !== model.providerID || approvalModel.modelID !== model.modelID)) return 'the approval model binding cannot change';
    approvalModel = model;
  }
  grants.set(id, { upstream: upstream.toString(), header, secret, headers: extra.headers, protocol, model });
  return null;
}

async function serveControl(request, response) {
  request.on('error', () => {});
  const path = String(request.url || '').split('?')[0];
  if (request.method === 'GET' && path === '/health') {
    answerJson(response, 200, { ready: true, mode: networkMode, domains: allowedDomains.size, grants: grants.size });
    return;
  }
  if (request.method === 'GET' && path === '/policy') {
    answerJson(response, 200, { mode: networkMode, domains: Array.from(allowedDomains), grants: Array.from(grants.keys()) });
    return;
  }
  if (request.method === 'GET' && path === '/journal') {
    answerJson(response, 200, { records: journal.slice(), dropped: journalDropped, since: STARTED_AT });
    return;
  }
  if (request.method !== 'POST' || (path !== '/network' && path !== '/grants')) {
    answerJson(response, 404, { error: 'no such control endpoint' });
    return;
  }
  const text = await readBody(request);
  let body = null;
  try {
    body = JSON.parse(text ?? '');
  } catch {
    answerJson(response, 400, { error: 'the body is not JSON' });
    return;
  }
  if (!(body instanceof Object) || Array.isArray(body)) {
    answerJson(response, 400, { error: 'the body is not an object' });
    return;
  }
  const problem = path === '/network' ? setNetwork(body) : addGrant(body);
  if (problem) answerJson(response, 400, { error: problem });
  else answerJson(response, 200, { ok: true });
}


let listening = false;
const lastNote = new Map();

function noteRefusedTraffic(listener, decision) {
  const key = `${listener}:${decision}`;
  const last = lastNote.get(key) ?? 0;
  if (Date.now() - last < NOTE_INTERVAL_MS) return;
  lastNote.set(key, Date.now());
  record(listener, '', 0, decision);
}

function makeServer(listener, maxConnections, handler) {
  const server = http.createServer({ maxHeaderSize: MAX_HEADER_BYTES }, handler);
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.maxConnections = maxConnections;
  server.on('drop', () => noteRefusedTraffic(listener, 'deny:too-many-connections'));
  server.on('clientError', (error, socket) => {
    if (error?.code !== 'ECONNRESET' && error?.code !== 'EPIPE') noteRefusedTraffic(listener, 'deny:unreadable-request');
    if (!socket.destroyed && socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
  });
  server.on('error', (error) => {
    console.error(`gatekeeper: listener error ${error.code || error.message}`);
    if (!listening) process.exit(1);
  });
  return server;
}

const listen = (server, port, host) => new Promise((resolve) => { server.listen(Number(port), host, resolve); });

async function main() {
  const bindHost = readBindHost(bindArgument);
  if (!bindHost || !corridorPort || !windowPort || !controlPort) {
    console.error('gatekeeper: arguments are <bind host> <corridor port> <window port> <control port>');
    process.exit(2);
  }
  const corridor = makeServer('corridor', MAX_CORRIDOR_CONNECTIONS, refusePlainProxy);
  corridor.on('connect', (request, socket, head) => {
    openTunnel(request, socket, head).catch(() => { socket.destroy(); });
  });
  const windowServer = makeServer('window', MAX_WINDOW_CONNECTIONS, (request, response) => {
    serveWindow(request, response).catch(() => {
      if (!response.headersSent) answerJson(response, 502, { error: 'the window could not serve this request' });
      else response.destroy();
    });
  });
  windowServer.on('connect', (request, socket) => {
    record('window', 'model-protocol', 0, 'deny:model-protocol');
    refuse(socket, 403, 'Forbidden', REFUSED);
  });
  const control = makeServer('control', MAX_CONTROL_CONNECTIONS, (request, response) => {
    serveControl(request, response).catch(() => {
      if (!response.headersSent) answerJson(response, 500, { error: 'the control channel could not serve this request' });
      else response.destroy();
    });
  });
  await listen(corridor, corridorPort, bindHost);
  await listen(windowServer, windowPort, bindHost);
  await listen(control, controlPort, CONTROL_HOST);
  listening = true;
  process.on('uncaughtException', (error) => {
    console.error(`gatekeeper: kept running after ${describeFailure(error)}`);
  });
  process.on('unhandledRejection', (reason) => {
    console.error(`gatekeeper: kept running after a rejected promise, ${describeFailure(reason)}`);
  });
  console.log(`gatekeeper: corridor ${corridorPort}, window ${windowPort}, control ${CONTROL_HOST}:${controlPort}`);
}

function describeFailure(error) {
  if (!(error instanceof Error)) return 'something that is not an error';
  const frame = String(error.stack ?? '').split('\n').find((line) => line.trim().startsWith('at ')) ?? '';
  return `${error.name}${error.code ? ` (${error.code})` : ''}${frame ? ` ${frame.trim()}` : ''}`;
}

if (require.main === module) {
  main();
} else {
  module.exports = { approvalPolicy: approval, createApprovalBodies, addGrant, chooseAddress, isBlockedAddress, isDomainName, joinSockets, parseIPv4, parseIPv6, refuseTarget, setNetwork, splitTarget, walksOutOfGrant };
}
