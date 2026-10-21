// Development loop: API host with file watching on a fixed port + Vite dev server for the renderer.
// Open the printed URL in a browser, or run `pnpm dev:desktop` for the Electron shell.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// pnpm is a .cmd shim on Windows; run its JS entry point without a shell.
const pnpmCommand = (args) => (process.env.npm_execpath ? [process.execPath, [process.env.npm_execpath, ...args]] : ['pnpm', args]);
const port = process.env.PULSEFLOW_PORT ?? '5199';
const token = process.env.PULSEFLOW_TOKEN ?? crypto.randomBytes(18).toString('base64url');
const env = {
  ...process.env,
  PULSEFLOW_PORT: port,
  PULSEFLOW_TOKEN: token,
  PULSEFLOW_DATA_DIR: process.env.PULSEFLOW_DATA_DIR ?? path.join(root, '.pulseflow-dev'),
  PULSEFLOW_DEV_API: `http://127.0.0.1:${port}`,
};

const children = [
  spawn(
    ...pnpmCommand(['--filter', '@pulseflow/server', 'exec', 'tsx', 'watch', '--disable-warning=ExperimentalWarning', 'src/cli.ts', 'serve', '--port', port]),
    {
      cwd: root,
      env,
      stdio: 'inherit',
    },
  ),
  spawn(...pnpmCommand(['--filter', '@pulseflow/desktop', 'dev:renderer']), { cwd: root, env, stdio: 'inherit' }),
];
setTimeout(() => console.log(`\n  PulseFlow dev UI: http://localhost:5173/#token=${token}\n`), 2500);

const stop = () => {
  for (const c of children) c.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
