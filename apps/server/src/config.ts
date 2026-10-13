import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type HostMode = 'local' | 'server';

export interface HostConfig {
  mode: HostMode;
  dataDir: string;
  /** App-owned directory always writable by workflows (demo outputs, template fixtures). */
  demoDir: string;
  host: string;
  /** 0 = pick a free port. */
  port: number;
  /** 32-byte key used to encrypt credentials at rest. */
  masterKey: Buffer;
  /** Local mode bearer token required for all /api calls. */
  localToken: string;
  /** Directory containing the built renderer (index.html), if the UI should be served. */
  staticDir?: string;
  /** Serve the deterministic /demo fixture endpoints used by offline templates. */
  fixtures: boolean;
  /** Public base URL used when displaying webhook URLs (server mode behind a proxy). */
  publicUrl?: string;
  appVersion: string;
  logLevel: 'silent' | 'error' | 'warn' | 'info' | 'debug';
  /** Max executions running at once across all workflows. */
  maxConcurrentExecutions: number;
  /** Max queued (not yet started) runs per workflow before new triggers go to the dead-letter queue. */
  maxQueuedPerWorkflow?: number;
}

export function buildConfig(overrides: Partial<HostConfig> & { dataDir?: string } = {}): HostConfig {
  const dataDir = path.resolve(overrides.dataDir ?? defaultDataDir());
  const mode = overrides.mode ?? (process.env.PULSEFLOW_MODE === 'server' ? 'server' : 'local');
  return {
    mode,
    dataDir,
    demoDir: overrides.demoDir ?? path.join(dataDir, 'demo'),
    host: overrides.host ?? process.env.PULSEFLOW_HOST ?? '127.0.0.1',
    port: overrides.port ?? Number(process.env.PULSEFLOW_PORT ?? 0),
    masterKey: overrides.masterKey ?? loadOrCreateKeyFile(dataDir, () => crypto.randomBytes(32)),
    localToken: overrides.localToken ?? process.env.PULSEFLOW_TOKEN ?? crypto.randomBytes(24).toString('base64url'),
    ...(overrides.staticDir ? { staticDir: overrides.staticDir } : {}),
    fixtures: overrides.fixtures ?? (process.env.PULSEFLOW_FIXTURES ? process.env.PULSEFLOW_FIXTURES !== '0' : mode === 'local'),
    ...((overrides.publicUrl ?? process.env.PULSEFLOW_PUBLIC_URL) ? { publicUrl: overrides.publicUrl ?? process.env.PULSEFLOW_PUBLIC_URL } : {}),
    appVersion: overrides.appVersion ?? APP_VERSION,
    logLevel: overrides.logLevel ?? 'info',
    maxConcurrentExecutions: overrides.maxConcurrentExecutions ?? 4,
    ...(overrides.maxQueuedPerWorkflow !== undefined ? { maxQueuedPerWorkflow: overrides.maxQueuedPerWorkflow } : {}),
  };
}

export const APP_VERSION = '0.1.0';

export function defaultDataDir(): string {
  if (process.env.PULSEFLOW_DATA_DIR) return path.resolve(process.env.PULSEFLOW_DATA_DIR);
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'PulseFlow');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'PulseFlow');
  return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), 'pulseflow');
}

/**
 * Loads or creates the master key file. On desktop the Electron main process supplies a key
 * protected by the OS keychain (safeStorage) instead; this file-based key is the documented
 * fallback for headless/server use and is protected only by file permissions.
 */
export function loadOrCreateKeyFile(dataDir: string, generate: () => Buffer): Buffer {
  if (process.env.PULSEFLOW_MASTER_KEY) {
    const k = Buffer.from(process.env.PULSEFLOW_MASTER_KEY, 'base64');
    if (k.length !== 32) throw new Error('PULSEFLOW_MASTER_KEY must be 32 bytes, base64 encoded');
    return k;
  }
  const file = path.join(dataDir, 'master.key');
  if (fs.existsSync(file)) {
    const k = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
    if (k.length !== 32) throw new Error(`Corrupt key file ${file}`);
    return k;
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const k = generate();
  fs.writeFileSync(file, k.toString('base64'), { mode: 0o600 });
  return k;
}
