import { _electron as electron, test as base, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(__dirname, '../apps/desktop');
export const screenshotDir = path.resolve(__dirname, '../artifacts/screenshots');

export const test = base.extend<{ app: ElectronApplication; page: Page; dataDir: string }>({
  // eslint-disable-next-line no-empty-pattern
  dataDir: async ({}, use) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulseflow-e2e-'));
    await use(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  },
  app: async ({ dataDir }, use) => {
    if (!fs.existsSync(path.join(appDir, 'dist/main/main.cjs'))) throw new Error('Build the desktop app first: pnpm --filter @pulseflow/desktop build');
    const args = [appDir];
    if (process.platform === 'linux') args.push('--no-sandbox', '--disable-gpu');
    const app = await electron.launch({ args, env: { ...process.env, PULSEFLOW_DATA_DIR: dataDir }, timeout: 60_000 });
    await use(app);
    await app.close().catch(() => undefined);
  },
  page: async ({ app }, use) => {
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900));
    await page.getByTestId('app-ready').waitFor({ timeout: 60_000 });
    await use(page);
  },
});

export async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(screenshotDir, { recursive: true });
  await page.screenshot({ path: path.join(screenshotDir, `${name}.png`) });
}

export { expect } from '@playwright/test';
