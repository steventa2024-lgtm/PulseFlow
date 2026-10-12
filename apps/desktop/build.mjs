import { build as esbuild } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as viteBuild } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');
const dev = process.argv.includes('--dev');
const skipRenderer = process.argv.includes('--no-renderer');

for (const d of ['main', 'preload', 'host']) fs.rmSync(path.join(dist, d), { recursive: true, force: true });

const node = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: dev ? 'inline' : 'linked',
  legalComments: 'linked',
  external: ['electron'],
  logLevel: 'info',
  define: { 'process.env.PULSEFLOW_DEV': JSON.stringify(dev ? '1' : '') },
};

await esbuild({ ...node, entryPoints: [path.join(root, 'src/main/main.ts')], outfile: path.join(dist, 'main/main.cjs') });
// Preload runs in a sandboxed renderer: only `electron`'s contextBridge/ipcRenderer are available.
await esbuild({ ...node, platform: 'browser', entryPoints: [path.join(root, 'src/preload/preload.ts')], outfile: path.join(dist, 'preload/preload.cjs') });
await esbuild({ ...node, entryPoints: [path.join(root, '../server/src/utility.ts')], outfile: path.join(dist, 'host/utility.cjs') });

fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
for (const f of fs.readdirSync(path.join(root, 'assets'))) fs.copyFileSync(path.join(root, 'assets', f), path.join(dist, 'assets', f));

if (!skipRenderer) await viteBuild({ configFile: path.join(root, 'vite.config.mts'), logLevel: 'warn' });
console.log('desktop build complete');
