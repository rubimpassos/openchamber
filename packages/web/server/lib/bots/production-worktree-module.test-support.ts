import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { pathToFileURL } from 'node:url';

const checkoutModules = ['production-worktrees', 'production-worktree-contracts', 'production-worktree-owner',
  'production-worktree-adoption', 'production-worktree-publication', 'production-worktree-snapshot', 'production-git'] as const;
type CheckoutModule = typeof checkoutModules[number];
type SourceChanges = Readonly<Partial<Record<CheckoutModule, (source: string) => string>>>;

export async function loadCheckoutModules(directory: string, changes: SourceChanges = {}): Promise<{
  readonly worktrees: typeof import('./production-worktrees.js');
  readonly git: typeof import('./production-git.js');
}> {
  await fs.mkdir(directory, { recursive: true });
  const destinations = new Map(checkoutModules.map((name) => [`./${name}.js`, pathToFileURL(path.join(directory, `${name}.mjs`)).href]));
  for (const name of checkoutModules) {
    const url = new URL(`./${name}.ts`, import.meta.url);
    const original = await fs.readFile(url, 'utf8');
    const source = changes[name]?.(original) ?? original;
    const emitted = stripTypeScriptTypes(source, { mode: 'strip' });
    const absolute = emitted.replace(/from (['"])([^'"]+)\1/g, (_match, _quote: string, specifier: string) => {
      let resolved = destinations.get(specifier);
      if (!resolved) {
        if (specifier.startsWith('.')) {
          const dependency = new URL(specifier, url);
          const typed = new URL(dependency.href.replace(/\.js$/, '.ts'));
          resolved = existsSync(dependency) ? dependency.href : typed.href;
        } else resolved = import.meta.resolve(specifier);
      }
      return `from ${JSON.stringify(resolved)}`;
    });
    await fs.writeFile(path.join(directory, `${name}.mjs`), absolute);
  }
  return {
    worktrees: await import(/* @vite-ignore */ pathToFileURL(path.join(directory, 'production-worktrees.mjs')).href),
    git: await import(/* @vite-ignore */ pathToFileURL(path.join(directory, 'production-git.mjs')).href),
  };
}
