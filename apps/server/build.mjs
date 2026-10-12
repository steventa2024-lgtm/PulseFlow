import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const outdir = path.join(root, 'dist');
fs.rmSync(outdir, { recursive: true, force: true });

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: 'linked',
  legalComments: 'linked',
  logLevel: 'info',
  external: ['electron'],
};

await build({ ...common, entryPoints: { cli: path.join(root, 'src/cli.ts') }, outdir, outExtension: { '.js': '.cjs' }, banner: { js: '#!/usr/bin/env node' } });
await build({ ...common, entryPoints: { utility: path.join(root, 'src/utility.ts') }, outdir, outExtension: { '.js': '.cjs' } });
