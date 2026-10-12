import { buildConfig } from './config';
import { createHost, type Host } from './host';

/**
 * Entry point used when the host runs inside an Electron utilityProcess. The desktop main
 * process sends a `start` message (the master key comes from the OS keychain via safeStorage)
 * and receives `ready` with the loopback URL and per-launch token.
 */
interface ParentPort {
  on(event: 'message', fn: (e: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

type StartMessage = {
  type: 'start';
  dataDir: string;
  masterKey: string;
  staticDir?: string;
  port?: number;
};

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (!parentPort) {
  console.error('utility entry must run inside an Electron utilityProcess');
  process.exit(1);
}

let host: Host | null = null;

parentPort.on('message', (e) => {
  const msg = e.data as StartMessage | { type: 'stop' };
  if (msg.type === 'start') void start(msg);
  else if (msg.type === 'stop') void stop();
});

async function start(msg: StartMessage): Promise<void> {
  try {
    const masterKey = Buffer.from(msg.masterKey, 'base64');
    if (masterKey.length !== 32) throw new Error('Invalid master key');
    const config = buildConfig({
      dataDir: msg.dataDir,
      masterKey,
      host: '127.0.0.1',
      port: msg.port ?? 0,
      mode: 'local',
      ...(msg.staticDir ? { staticDir: msg.staticDir } : {}),
    });
    host = await createHost(config, {
      onNotify: (n) => parentPort!.postMessage({ type: 'notify', ...n }),
      log: (level, message) => parentPort!.postMessage({ type: 'log', level, message }),
    });
    parentPort!.postMessage({ type: 'ready', url: host.url, token: config.localToken, dataDir: config.dataDir });
  } catch (err) {
    parentPort!.postMessage({ type: 'error', message: (err as Error).message });
  }
}

async function stop(): Promise<void> {
  try {
    await host?.close();
  } finally {
    parentPort!.postMessage({ type: 'stopped' });
    process.exit(0);
  }
}
