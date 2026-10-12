import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function makeTempDir(prefix = 'pulseflow-test-'): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function removeDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Polls `fn` until it returns a truthy value (or stops throwing) within `timeoutMs`. */
export async function eventually<T>(fn: () => T | Promise<T>, { timeoutMs = 10_000, intervalMs = 50 } = {}): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v as NonNullable<T>;
    } catch (e) {
      lastError = e;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Condition not met within ${timeoutMs}ms${lastError ? `: ${(lastError as Error).message}` : ''}`);
}
