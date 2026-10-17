// Test support only. The production window policy stays intact. DNS and the TLS destination
// port are redirected in the child to a controlled HTTPS upstream with a disposable CA.
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';

import { GATEKEEPER_PROGRAM } from './gatekeeper-channel.js';

export async function startApprovalGatekeeper({ directory, purpose = 'pr-fix-loop-approval', bodyLimits = null }) {
  const certificate = path.join(directory, 'ca.pem');
  const key = path.join(directory, 'key.pem');
  const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', certificate, '-days', '1', '-subj', '/CN=approval-test', '-addext', 'subjectAltName=DNS:api.openai.com,DNS:api.anthropic.com,DNS:chatgpt.com,DNS:api.githubcopilot.com,DNS:api.individual.githubcopilot.com']);
  if (made.status !== 0) throw new Error(`The controlled TLS upstream needs openssl: ${made.error?.message ?? made.stderr}`);
  const seen = [];
  const events = new EventEmitter();
  const upstream = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(certificate) }, async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    seen.push({ path: request.url, method: request.method, headers: request.headers, body: Buffer.concat(chunks).toString() });
    events.emit('upstream');
    if (request.headers['x-request-id'] === 'reset') { request.socket.destroy(); return; }
    if (request.headers['x-request-id']?.endsWith('-hold')) return;
    if (request.headers['x-request-id'] === 'redirect') {
      response.writeHead(307, { location: 'https://api.github.com/repos/a/b/git/refs' });
    } else response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"model":"controlled-model"}');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const program = path.join(directory, 'gatekeeper.cjs');
  const bootstrap = [
    "'use strict';",
    `module.exports.spacePurpose = ${JSON.stringify(purpose)};`,
    'const testDns = require("node:dns");',
    'testDns.lookup = (host, options, callback) => callback(null, [{ address: "127.0.0.1", family: 4 }]);',
    'const testHttps = require("node:https"); const originalRequest = testHttps.request;',
    `testHttps.request = (options, callback) => { const outgoing = originalRequest({ ...options, port: ${upstream.address().port} }, callback); outgoing.once("close", () => queueMicrotask(() => process.send({ kind: "released", ...stats() }))); return outgoing; };`,
    // Port 0 allocates each listener atomically. Reserving and releasing a free port before
    // spawning the child allowed duplicate selections and races with other test processes.
    'const testHttp = require("node:http"); const originalListen = testHttp.Server.prototype.listen; const boundPorts = [];',
    'testHttp.Server.prototype.listen = function (...args) { this.once("listening", () => { boundPorts.push(this.address().port); if (boundPorts.length === 3) process.send(boundPorts); }); return originalListen.apply(this, args); };',
    'const stats = () => ({ bodies: approvalBodies.inspect(), memory: process.memoryUsage() });',
    'process.on("message", (message) => { if (message.kind === "stats") process.send({ kind: "stats", id: message.id, ...stats() }); });',
    'const originalEmit = testHttp.Server.prototype.emit;',
    'testHttp.Server.prototype.emit = function (event, ...args) { if (event === "request") { const request = args[0]; const id = request.headers["x-request-id"]; if (id?.startsWith("upload-")) { let bytes = 0; request.on("data", (chunk) => { bytes += chunk.length; if (bytes >= Number(request.headers["x-test-bytes"])) queueMicrotask(() => { if (args[1].statusCode !== 503) process.send({ kind: "upload", id, bytes, ...stats() }); }); }); request.on("aborted", () => queueMicrotask(() => process.send({ kind: "released", ...stats() }))); } } return originalEmit.call(this, event, ...args); };',
  ].join('\n');
  fs.writeFileSync(program, `${bootstrap}\n${GATEKEEPER_PROGRAM}`);
  const limitArguments = bodyLimits === null ? [] : ['300000', '128', '64', '8', ...[bodyLimits.maximum, bodyLimits.total, bodyLimits.deadline ?? 10000, bodyLimits.tokens ?? 16384, bodyLimits.depth ?? 32].map(String)];
  const child = spawn(process.execPath, [program, '127.0.0.1', '0', '0', '0', ...limitArguments], {
    env: { ...process.env, NODE_EXTRA_CA_CERTS: certificate }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  const observations = [];
  child.on('message', (message) => {
    if (Array.isArray(message)) return;
    observations.push(message);
    events.emit(message.id ?? message.kind, message);
    events.emit('resources', message);
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (chunk) => { output += chunk; });
  let ports;
  try {
    const [message] = await Promise.race([
      once(child, 'message', { signal: AbortSignal.timeout(10_000) }),
      once(child, 'exit').then(([code]) => { throw new Error(`Gatekeeper exited with ${code}: ${output}`); }),
    ]);
    const [corridor, window, control] = message;
    ports = { corridor, window, control };
  } catch (error) {
    child.kill('SIGKILL');
    upstream.closeAllConnections();
    upstream.close();
    throw error;
  }
  const request = ({ listener = 'control', method = 'GET', path: target, body, rawBody, headers = {} }) => new Promise((resolve, reject) => {
    const call = http.request({ host: '127.0.0.1', port: ports[listener], method, path: target, headers, signal: AbortSignal.timeout(5000) }, (answer) => {
      let text = '';
      answer.on('data', (chunk) => { text += chunk; });
      answer.on('end', () => resolve({ status: answer.statusCode, headers: answer.headers, body: text }));
      answer.on('error', reject);
    });
    call.on('error', reject);
    call.on('connect', (answer, socket) => {
      socket.destroy();
      resolve({ status: answer.statusCode, headers: answer.headers, body: '' });
    });
    call.end(rawBody ?? (body === undefined ? undefined : JSON.stringify(body)));
  });
  const connect = () => new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: ports.corridor });
    socket.on('connect', () => socket.write('CONNECT api.github.com:443 HTTP/1.1\r\n\r\n'));
    socket.once('data', (chunk) => { socket.destroy(); resolve(chunk.toString()); });
    socket.once('error', reject);
    socket.setTimeout(5000, () => { socket.destroy(); reject(new Error('CONNECT was not answered')); });
  });
  let sequence = 0;
  const resources = async () => {
    const id = `stats-${sequence++}`;
    const answer = once(events, id, { signal: AbortSignal.timeout(5000) });
    child.send({ kind: 'stats', id });
    return (await answer)[0];
  };
  const bodiesIdle = () => new Promise((resolve, reject) => {
    const signal = AbortSignal.timeout(5000);
    const finish = (error) => {
      events.removeListener('resources', observe);
      signal.removeEventListener('abort', expired);
      if (error) reject(error); else resolve();
    };
    const observe = (message) => { if (message.bodies?.active === 0) finish(); };
    const expired = () => finish(new Error('model body reservations were not released'));
    events.on('resources', observe);
    signal.addEventListener('abort', expired, { once: true });
    resources().then(observe, finish);
  });
  const openUpload = ({ bytes = 15 * 1024, hold = false, model = 'gpt-4.1' } = {}) => {
    const id = `upload-${sequence++}${hold ? '-hold' : ''}`;
    const prefix = Buffer.from(JSON.stringify({ model, input: '' }).slice(0, -2));
    const partial = Buffer.concat([prefix, Buffer.alloc(bytes - prefix.length, 0x78)]);
    let observe;
    const observed = new Promise((resolve) => { observe = resolve; });
    events.once(id, (message) => observe({ received: message.bytes, ...message }));
    let answered;
    const answer = new Promise((resolve) => { answered = resolve; });
    const call = http.request({ host: '127.0.0.1', port: ports.window, method: 'POST', path: '/model/openai/responses', headers: { 'content-length': partial.length + 2, 'x-request-id': id, 'x-test-bytes': partial.length } }, (response) => {
      response.resume();
      response.on('end', () => { observe({ status: response.statusCode }); answered({ status: response.statusCode }); });
    });
    call.on('error', () => { observe({ status: 0 }); answered({ status: 0 }); });
    call.write(partial);
    return { observed, answer, finish: () => call.end('"}'), abort: () => call.destroy() };
  };
  const upstreamReceived = async (count) => {
    while (seen.length < count) await once(events, 'upstream', { signal: AbortSignal.timeout(5000) });
  };
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  };
  return { seen, request, connect, close, resources, observations, openUpload, upstreamReceived, bodiesIdle };
}
