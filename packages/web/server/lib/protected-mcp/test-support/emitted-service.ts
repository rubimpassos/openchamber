import fs from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverSource = fileURLToPath(new URL('../../../', import.meta.url));

export async function emitServiceFixture(target: string): Promise<void> {
  const service = 'lib/protected-mcp/service';
  const names = (await fs.readdir(path.join(serverSource, service)))
    .filter((name) => /\.(?:js|ts)$/.test(name) && !/\.(?:test|d)\.(?:js|ts)$/.test(name));
  const files = [
    ...names.map((name) => path.join(service, name)),
    'lib/shared/guards.ts',
    'lib/shared/object-guards.ts',
  ];
  for (const file of files) {
    const source = await fs.readFile(path.join(serverSource, file), 'utf8');
    const output = file.replace(/\.ts$/, '.js');
    const destination = path.join(target, output);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, file.endsWith('.ts') ? stripTypeScriptTypes(source) : source);
  }
  await fs.writeFile(path.join(target, 'package.json'), '{"type":"module"}\n');
}
