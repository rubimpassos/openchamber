import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import lintConfig from '../../../oxlint.config.ts';
import antiSlopConfig from '../../../oxlint.anti-slop.config.ts';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

test('unknown boundary parameters require exclusive consumption by an immutable imported Zod object schema', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-server-schema-lint-'));
  const file = path.join(root, 'packages/web/server/lib/example.ts');
  const schema = 'const schema = z.object({ id: z.string() });';
  const parse = 'export function parse(value: unknown) { return schema.safeParse(value); }';
  const cases = [
    [schema + parse, 0],
    [`import { z as validator } from 'zod'; ${schema.replaceAll('z.', 'validator.')} ${parse}`, 0],
    [`type Output = z.output<typeof schema>; ${schema} ${parse}`, 0],
    [schema.replace('});', '}).strict();') + parse, 0],
    [`const schema = z.object({ text: z.unknown().optional() }); ${parse}`, 0],
    [`export const parse = (value: unknown) => { ${schema} return schema.safeParse(value); };`, 0],
    [`${schema} export function parse(typed: string, value: unknown) { return schema.safeParse(value); }`, 0],
    [`${schema} export function parse(value: unknown) { schema.safeParse(value); return value; }`, 1],
    [`${schema} export function parse(value: unknown) { schema.safeParse(value); forward(value); }`, 1],
    [`${schema} export function parse(value: unknown) { forward(arguments); return schema.safeParse(value); }`, 1],
    [`${schema} export function parse(value: unknown) { forward(eval('value')); return schema.safeParse(value); }`, 1],
    [`${schema} export function parse(value: unknown) { forward(() => eval('value')); return schema.safeParse(value); }`, 1],
    [`${schema} export function parse(value: unknown) { const raw = value; return schema.safeParse(raw); }`, 1],
    [`${schema} export function parse(value: unknown) { return () => schema.safeParse(value); }`, 1],
    [`${schema} export function parse(value: unknown) { return class { result = schema.safeParse(value); }; }`, 1],
    [`${schema} export function parse(value: unknown) { value = {}; return schema.safeParse(value); }`, 1],
    [`${schema} export function parse(value: unknown) { const nested = (value: string) => schema.safeParse(value); return nested(''); }`, 1],
    [`${schema} export function parse(value: unknown, raw: unknown) { return schema.safeParse(value); }`, 1],
    [`const schema = { safeParse: (value: string) => value }; ${parse}`, 1],
    [`const schema = z.unknown(); ${parse}`, 1],
    ['export const parse = (value: unknown) => z.unknown().safeParse(value);', 1],
    [`export const parse = <Schema extends z.ZodType>(schema: Schema, value: unknown): z.output<Schema> => schema.safeParse(value);`, 1],
    [`const schema = z.object({}).passthrough(); ${parse}`, 1],
    [`let schema = z.object({}); ${parse}`, 1],
    [`${schema} schema = fake; ${parse}`, 1],
    [`${schema} schema.safeParse = fake; ${parse}`, 1],
    [`${schema} forward(schema); ${parse}`, 1],
    [`export ${schema} ${parse}`, 1],
    [`${schema} export function parse(value: unknown, schema: Fake) { return schema.safeParse(value); }`, 1],
    [`function scope(z: Fake) { ${schema} ${parse.replace('export ', '')} }`, 1],
    [`z.object = fake; ${schema} ${parse}`, 1],
    [`forward(z); ${schema} ${parse}`, 1],
    [`import { z as other } from 'zod'; forward(other); ${schema} ${parse}`, 1],
    [`Object.getPrototypeOf(z.object({})).safeParse = fake; ${schema} ${parse}`, 1],
    [`Object['getPrototypeOf'](z.object({})).safeParse = fake; ${schema} ${parse}`, 1],
    [`import { object } from 'zod'; Object.getPrototypeOf(object({})).safeParse = fake; ${schema} ${parse}`, 1],
    [`z.object({}).constructor.prototype.safeParse = fake; ${schema} ${parse}`, 1],
    [`${schema} export function parse(value: unknown = {}) { return schema.safeParse(value); }`, 1],
  ];
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const config = path.join(root, 'oxlint.json');
    fs.writeFileSync(config, JSON.stringify({
      ...antiSlopConfig,
      jsPlugins: antiSlopConfig.jsPlugins.map((plugin) => ({ ...plugin, specifier: path.resolve(repoRoot, plugin.specifier) })),
    }));
    for (const [source, expected] of cases) {
      fs.writeFileSync(file, `import { z } from 'zod'; ${source}`);
      const result = spawnSync(path.join(repoRoot, 'node_modules/.bin/oxlint'), [
        '-c', config, '-f', 'json', file,
      ], { cwd: root, encoding: 'utf8' });
      expect(result.stderr).toBe('');
      const diagnostics = JSON.parse(result.stdout).diagnostics;
      expect(diagnostics.filter(({ code }) => code === 'anti-slop(no-unknown-parameters)'), source).toHaveLength(expected);
    }
    for (const imported of ["import { z } from './fake.js';", 'const z = fake;']) {
      fs.writeFileSync(file, `${imported} ${schema} ${parse}`);
      const result = spawnSync(path.join(repoRoot, 'node_modules/.bin/oxlint'), [
        '-c', config, '-f', 'json', file,
      ], { cwd: root, encoding: 'utf8' });
      expect(JSON.parse(result.stdout).diagnostics.map(({ code }) => code)).toContain('anti-slop(no-unknown-parameters)');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('server TypeScript lint rejects unsafe syntax and undocumented suppression', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-server-lint-'));
  const file = path.join(root, 'packages/web/server/lib/example.ts');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const config = path.join(root, 'oxlint.json');
    fs.writeFileSync(config, JSON.stringify({
      ...lintConfig,
      jsPlugins: lintConfig.jsPlugins.map((plugin) => ({ ...plugin, specifier: path.resolve(repoRoot, plugin.specifier) })),
    }));
    fs.writeFileSync(file, `
      export const value: any = 1;
      export const required = value!;
      // @ts-ignore
      export const ignored = value;
      // @ts-expect-error
      export const expected = value;
      export { value as other } from './other.ts';
      export type { Input } from './input';
      export const lazy = () => import('./lazy.ts');
      export type Imported = import('./types').Value;
    `);
    const run = () => spawnSync(path.join(repoRoot, 'node_modules/.bin/oxlint'), [
      '-c', config, '-f', 'json', file,
    ], { cwd: root, encoding: 'utf8' });
    const invalid = run();
    expect(invalid.status, invalid.stderr).not.toBe(0);
    const diagnostics = JSON.parse(invalid.stdout).diagnostics;
    expect(diagnostics.filter(({ code }) => code === 'typescript(no-explicit-any)')).toHaveLength(1);
    expect(diagnostics.filter(({ code }) => code === 'typescript(no-non-null-assertion)')).toHaveLength(1);
    expect(diagnostics.filter(({ code }) => code === 'typescript(ban-ts-comment)')).toHaveLength(2);
    expect(diagnostics.filter(({ code }) => code === 'openchamber(server-js-specifiers)')).toHaveLength(4);
    fs.writeFileSync(file, `
      // @ts-expect-error: Deliberately checks the invalid boundary contract.
      export const expected: number = 'invalid';
      // @ts-ignore: Upstream platform types omit this supported runtime property.
      export const ignored: number = 'invalid';
      export { value as other } from './other.js';
      export type { Input } from './input.js';
      export const lazy = () => import('./lazy.js');
      export type Imported = import('./types.js').Value;
    `);
    const documented = run();
    expect(documented.status, documented.stdout + documented.stderr).toBe(0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('external input type guards are allowed while unparsed helpers and redundant typeof checks fail', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-server-guard-lint-'));
  const file = path.join(root, 'packages/web/server/lib/example.ts');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const config = path.join(root, 'oxlint.json');
    fs.writeFileSync(config, JSON.stringify({
      ...antiSlopConfig,
      jsPlugins: antiSlopConfig.jsPlugins.map((plugin) => ({ ...plugin, specifier: path.resolve(repoRoot, plugin.specifier) })),
    }));
    const run = () => spawnSync(path.join(repoRoot, 'node_modules/.bin/oxlint'), [
      '-c', config, '-f', 'json', file,
    ], { cwd: root, encoding: 'utf8' });
    fs.writeFileSync(file, `
      export interface Input { id: string }
      export function isInput(value: unknown): value is Input {
        return value !== null && typeof value === 'object' && 'id' in value && typeof value.id === 'string';
      }
    `);
    const guard = run();
    expect(guard.status, guard.stdout + guard.stderr).toBe(0);
    fs.appendFileSync(file, `
      export function unparsed(value: unknown): boolean { return typeof value === 'string'; }
      export function redundant(value: string): boolean { return typeof value === 'string'; }
    `);
    const invalid = run();
    expect(invalid.status).not.toBe(0);
    const diagnostics = JSON.parse(invalid.stdout).diagnostics;
    expect(diagnostics.filter(({ code }) => code === 'anti-slop(no-unknown-parameters)')).toHaveLength(1);
    expect(diagnostics.filter(({ code }) => code === 'anti-slop(no-runtime-typeof)')).toHaveLength(2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('only exported single-unknown nullable parsers in the shared server folder admit boundary checks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-server-parser-lint-'));
  try {
    const config = path.join(root, 'oxlint.json');
    fs.writeFileSync(config, JSON.stringify({
      ...antiSlopConfig,
      jsPlugins: antiSlopConfig.jsPlugins.map((plugin) => ({ ...plugin, specifier: path.resolve(repoRoot, plugin.specifier) })),
    }));
    const run = (relative, source) => {
      const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, source);
      const result = spawnSync(path.join(repoRoot, 'node_modules/.bin/oxlint'), [
        '-c', config, '-f', 'json', file,
      ], { cwd: root, encoding: 'utf8' });
      expect(result.stderr).toBe('');
      return JSON.parse(result.stdout).diagnostics.map(({ code }) => code);
    };
    const shared = 'packages/web/server/lib/shared/parser.ts';
    for (const declaration of [
      'export function parse(value: unknown): string | null',
      'export const parse = (value: unknown): string | null =>',
      'export const parse = function(value: unknown): string | null',
      'export default function(value: unknown): string | null',
    ]) {
      expect(run(shared, `${declaration} { return typeof value === 'string' ? value : null; }`)).toEqual([]);
    }
    for (const declaration of [
      'function parse(value: unknown): string | null',
      'export function parse(value: unknown): string',
      'export function parse(value: unknown): boolean',
      'export function parse(value: unknown)',
      'export function parse(value: unknown, other: string): string | null',
      'export function parse(...value: unknown[]): string | null',
      'export function parse(value: unknown = null): string | null',
      'export function parse(value: unknown): unknown | null',
      'export function parse(value: unknown): any | null',
    ]) {
      const codes = run(shared, `${declaration} { return typeof value === 'string' ? value : null; }`);
      expect(codes).toContain('anti-slop(no-runtime-typeof)');
      if (!declaration.includes('unknown[]')) expect(codes).toContain('anti-slop(no-unknown-parameters)');
    }
    expect(run(shared, `export function parse(value: string): string | null {
      return typeof value === 'string' ? value : null;
    }`)).toContain('anti-slop(no-runtime-typeof)');
    expect(run(shared, `export function parse(value: unknown): string | null {
      const nested = () => typeof value === 'string';
      return nested() ? '' : null;
    }`)).toContain('anti-slop(no-runtime-typeof)');
    for (const file of [
      'packages/web/server/lib/other/parser.ts',
      'packages/web/server/lib/shared-other/parser.ts',
      'packages/web/bin/parser.ts',
      'packages/ui/src/parser.ts',
    ]) {
      const codes = run(file, `export function parse(value: unknown): string | null {
        return typeof value === 'string' ? value : null;
      }`);
      expect(codes).toContain('anti-slop(no-unknown-parameters)');
      expect(codes).toContain('anti-slop(no-runtime-typeof)');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
