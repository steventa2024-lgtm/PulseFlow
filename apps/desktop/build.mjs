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

const inputs = new Set();
const record = (result) => Object.keys(result.metafile.inputs).forEach((i) => inputs.add(path.resolve(root, i)));

record(await esbuild({ ...node, metafile: true, entryPoints: [path.join(root, 'src/main/main.ts')], outfile: path.join(dist, 'main/main.cjs') }));
// Preload runs in a sandboxed renderer: only `electron`'s contextBridge/ipcRenderer are available.
record(
  await esbuild({
    ...node,
    metafile: true,
    platform: 'browser',
    entryPoints: [path.join(root, 'src/preload/preload.ts')],
    outfile: path.join(dist, 'preload/preload.cjs'),
  }),
);
record(await esbuild({ ...node, metafile: true, entryPoints: [path.join(root, '../server/src/utility.ts')], outfile: path.join(dist, 'host/utility.cjs') }));

fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
for (const f of fs.readdirSync(path.join(root, 'assets'))) fs.copyFileSync(path.join(root, 'assets', f), path.join(dist, 'assets', f));

if (!skipRenderer) {
  await viteBuild({
    configFile: path.join(root, 'vite.config.mts'),
    logLevel: 'warn',
    plugins: [
      {
        name: 'pulseflow-module-report',
        generateBundle() {
          for (const id of this.getModuleIds()) if (!id.startsWith('\0')) inputs.add(id.split('?')[0]);
        },
      },
    ],
  });
}
// Consumed by scripts/license-audit.mjs to know exactly which third-party packages ship in the app.
fs.writeFileSync(path.join(dist, 'bundled-modules.json'), `${JSON.stringify([...inputs].sort(), null, 1)}\n`);
console.log('desktop build complete');
