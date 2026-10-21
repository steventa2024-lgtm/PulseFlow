import { _electron as electron, type Page } from '@playwright/test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import type { Execution, ExecutionStep, Workflow, WorkflowGraph, WorkflowVersion } from '@pulseflow/contracts';
import { expect, shot, test } from './fixtures';

const appDir = path.resolve('apps/desktop');
const n = (id: string, type: string, name: string, parameters = {}, x = 0) => ({ id, type, name, typeVersion: 1, parameters, position: { x, y: 100 } });
const edge = (source: string, target: string) => ({ id: `${source}-${target}`, source, target, sourcePort: 'main', targetPort: 'main' });

async function api<T>(page: Page, method: string, url: string, body?: unknown): Promise<T> {
  return page.evaluate(
    async ({ method, url, body }) => {
      const connection = await window.pulseflow!.connection();
      const response = await fetch(url, {
        method,
        headers: { authorization: `Bearer ${connection.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) throw new Error(`${method} ${url}: ${response.status} ${await response.text()}`);
      return response.json();
    },
    { method, url, body },
  ) as Promise<T>;
}
async function hello(page: Page) {
  await page.getByTestId('nav-templates').click();
  await page.getByTestId('template-card-A01').click();
  await page.getByTestId('template-use').click();
  await expect(page.getByTestId('editor')).toBeVisible();
  await expect(page.getByTestId('validation')).toHaveText('Valid');
}
async function seed(page: Page, draft: WorkflowGraph, name: string) {
  const wf = await api<Workflow>(page, 'POST', '/api/workflows', { name, draft });
  await page.evaluate((id) => {
    window.location.hash = `/workflows/${id}`;
  }, wf.id);
  await expect(page.getByTestId('workflow-name')).toHaveValue(name);
  await expect(page.getByTestId('validation')).toHaveText('Valid');
  return wf;
}

test('studio stays usable at all four desktop sizes, with keyboard-accessible panels', async ({ page, app }) => {
  await hello(page);
  await expect(page.getByRole('button', { name: 'Dismiss', exact: true })).toHaveCount(0);
  for (const [width, height] of [
    [1920, 1080],
    [1440, 900],
    [1280, 800],
    [1024, 800],
  ]) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setContentSize(size[0]!, size[1]!), [width!, height!]);
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
    const sidebar = page.getByRole('navigation', { name: 'Main' });
    await expect(sidebar).toHaveAttribute('data-expanded', width! < 1200 ? 'false' : 'true');
    await expect.poll(async () => Math.round((await sidebar.boundingBox())!.width)).toBe(width! < 1200 ? 64 : 228);
    if (!(await page.getByRole('dialog', { name: 'Node Configuration drawer' }).isVisible())) await page.getByTestId('node-Build Greeting').click();
    await expect(page.getByTestId('inspector')).toBeVisible();
    await expect(page.getByTestId('validation')).toHaveText('Valid');
    await expect.poll(async () => Math.round((await page.getByTestId('inspector').boundingBox())!.width)).toBe(360);
    if (width! < 1280) {
      await expect(page.getByRole('dialog', { name: 'Node Configuration drawer' })).toBeVisible();
      await shot(page, `studio-${width}x${height}-drawer`);
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('inspector')).toBeHidden();
    }
    for (const action of ['save', 'run', 'deploy', 'add-node']) {
      const box = await page.getByTestId(action).boundingBox();
      expect(box).toBeTruthy();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width!);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
    await shot(page, `studio-${width}x${height}`);
  }
  await page.getByRole('button', { name: 'Expand sidebar', exact: true }).press('Enter');
  await expect(page.getByRole('navigation', { name: 'Main' })).toHaveAttribute('data-expanded', 'true');
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).press('Enter');
  await page.getByTestId('add-node').press('Enter');
  await expect(page.getByTestId('library-search')).toBeFocused();
  await page.getByTestId('library-search').fill('set fields');
  await expect(page.getByTestId('library-item-core.set')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('library-search')).toBeHidden();
});

test('Test Node executes real code in isolation and records SQLite test history', async ({ page, dataDir }) => {
  await hello(page);
  await page.getByTestId('node-Build Greeting').click();
  await page.getByTestId('test-node').click();
  await expect(page.getByTestId('node-test-dialog')).toContainText('real execution');
  await page.getByRole('textbox', { name: 'Node test input' }).fill('{invalid');
  await page.getByTestId('node-test-confirm').click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByRole('textbox', { name: 'Node test input' }).fill('[{"json":{"name":"Codex"}}]');
  await page.getByTestId('node-test-confirm').click();
  await expect(page.getByTestId('execution-header')).toHaveAttribute('data-state', 'succeeded');
  await expect(page.getByTestId('node-io')).toContainText('Hello, Codex!');
  const history = await api<Execution[]>(page, 'GET', '/api/executions');
  expect(history[0]!.mode).toBe('test');
  const detail = await api<{ steps: ExecutionStep[] }>(page, 'GET', `/api/executions/${history[0]!.id}`);
  expect(detail.steps).toHaveLength(2);
  expect(detail.steps.some((s) => s.nodeName === 'Save Greeting')).toBe(false);
  const db = new DatabaseSync(path.join(dataDir, 'pulseflow.db'), { readOnly: true });
  try {
    expect(db.prepare('SELECT mode,state FROM executions WHERE id=?').get(history[0]!.id)).toMatchObject({ mode: 'test', state: 'succeeded' });
  } finally {
    db.close();
  }
  await shot(page, 'studio-node-test-recorded');
});

test('a pending save cannot replace another workflow after navigation', async ({ page }) => {
  await hello(page);
  const original = (await api<Workflow[]>(page, 'GET', '/api/workflows'))[0]!;
  const next = await api<Workflow>(page, 'POST', '/api/workflows', {
    name: 'Other workflow',
    draft: { schemaVersion: 1, nodes: [n('t', 'core.manualTrigger', 'Start')], edges: [] },
  });
  await page.route(`**/api/workflows/${original.id}`, async (route) => {
    if (route.request().method() === 'PATCH') await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  await page.getByTestId('workflow-name').fill('Saved while navigating');
  const saved = page.waitForResponse((r) => r.url().endsWith(`/api/workflows/${original.id}`) && r.request().method() === 'PATCH');
  await page.getByTestId('save').click();
  await page.getByTestId('nav-workflows').click();
  await page.getByTestId('workflow-row-Other workflow').click();
  await saved;
  await expect(page.getByTestId('workflow-name')).toHaveValue('Other workflow');
  expect((await api<Workflow>(page, 'GET', `/api/workflows/${original.id}`)).name).toBe('Saved while navigating');
  expect((await api<Workflow>(page, 'GET', `/api/workflows/${next.id}`)).name).toBe('Other workflow');
});

test('Save preserves selection; Deploy activates locally; history compares and restores real versions', async ({ page }) => {
  const wf = await seed(
    page,
    {
      schemaVersion: 1,
      nodes: [
        n('t', 'core.scheduleTrigger', 'Daily', { mode: 'interval', intervalSeconds: 86400 }),
        n('value', 'core.set', 'Message', { fields: [{ name: 'message', value: 'Original' }] }, 300),
      ],
      edges: [edge('t', 'value')],
    },
    'Local deployment',
  );
  await page.getByTestId('node-Message').click();
  await page.getByTestId('node-name-input').fill('Message v1');
  await page.getByTestId('save').click();
  await expect(page.getByTestId('save-state')).toHaveText('Saved');
  await expect(page.getByTestId('node-name-input')).toHaveValue('Message v1');
  await page.getByTestId('deploy').click();
  await expect(page.getByRole('dialog', { name: 'Deploy locally' })).toContainText('on this computer');
  await page.getByRole('textbox', { name: 'Version note' }).fill('First local baseline');
  await page.getByTestId('publish-confirm').click();
  await expect(page.getByRole('switch', { name: 'Active', exact: true })).toHaveAttribute('aria-checked', 'true');
  const deployed = await api<Workflow>(page, 'GET', `/api/workflows/${wf.id}`);
  expect(deployed.active).toBe(true);
  expect(deployed.publishedVersionId).toBeTruthy();
  await page.getByTestId('node-name-input').fill('Message v2');
  await page.getByTestId('save').click();
  await expect(page.getByTestId('editor')).toContainText('Draft changes');
  await page.getByRole('button', { name: 'Version history', exact: true }).click();
  await expect(page.getByTestId('version-comparison')).toContainText('Message v2');
  await expect(page.getByTestId('version-comparison')).toContainText('name');
  await shot(page, 'studio-version-comparison');
  await page.getByTestId('versions-dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByTestId('deploy').click();
  await page.getByTestId('publish-confirm').click();
  await expect.poll(async () => (await api<WorkflowVersion[]>(page, 'GET', `/api/workflows/${wf.id}/versions`)).length).toBe(2);
  await page.getByRole('button', { name: 'Version history', exact: true }).click();
  const versions = await api<WorkflowVersion[]>(page, 'GET', `/api/workflows/${wf.id}/versions`);
  const first = versions.find((v) => v.versionNumber === 1)!;
  const second = versions.find((v) => v.versionNumber === 2)!;
  await page.getByRole('combobox', { name: 'Compare from' }).selectOption(first.id);
  await page.getByRole('combobox', { name: 'Compare to' }).selectOption(second.id);
  await expect(page.getByTestId('version-comparison')).toContainText('Message v2');
  await page.getByTestId('versions-dialog').getByRole('button', { name: 'Restore to draft' }).last().click();
  const restored = await api<Workflow>(page, 'GET', `/api/workflows/${wf.id}`);
  expect(restored.draft.nodes.find((n) => n.id === 'value')!.name).toBe('Message v1');
  expect(restored.active).toBe(true);
  expect(restored.publishedVersionId).toBe(second.id);
});

test('B09 is visibly demo-only, uses local fixtures and never reports publication', async ({ page, dataDir }) => {
  await page.getByTestId('nav-templates').click();
  await page.getByTestId('template-card-B09').click();
  await expect(page.getByTestId('mode-run-live')).toBeDisabled();
  await expect(page.getByTestId('template-dialog')).toContainText('No real social media posts are published');
  await page.getByTestId('template-use').click();
  await expect(page.getByTestId('demo-banner')).toContainText('local fixtures');
  await page.getByTestId('run').click();
  await expect(page.getByTestId('execution-header')).toHaveAttribute('data-state', 'succeeded');
  await page.getByTestId('console').getByRole('tab', { name: /Logs/ }).click();
  await expect(page.getByTestId('logs')).toContainText('No social media posts were published');
  const report = fs
    .readdirSync(path.join(dataDir, 'demo', 'templates'), { recursive: true })
    .map(String)
    .find((f) => f.endsWith('social-demo-receipts.json'))!;
  const receipts = JSON.parse(fs.readFileSync(path.join(dataDir, 'demo', 'templates', report), 'utf8')) as {
    previews: { demo: boolean; published: boolean }[];
  };
  expect(receipts.previews).toHaveLength(2);
  expect(receipts.previews.every((p) => p.demo && p.published === false)).toBe(true);
  await shot(page, 'studio-b09-demo');
});

test('Deploy retains the permission review before local activation', async ({ page }) => {
  const wf = await seed(
    page,
    {
      schemaVersion: 1,
      nodes: [
        n('t', 'core.scheduleTrigger', 'Daily', { mode: 'interval', intervalSeconds: 86400 }),
        n('write', 'core.fileWrite', 'Write Demo', { path: '{{ $app.demoDir }}/permission-qa.txt', content: 'Isolated QA', mode: 'overwrite' }, 300),
      ],
      edges: [edge('t', 'write')],
    },
    'Permission review',
  );
  await page.getByTestId('deploy').click();
  await expect(page.getByTestId('permissions-dialog')).toBeVisible();
  expect((await api<Workflow>(page, 'GET', `/api/workflows/${wf.id}`)).active).toBe(false);
  await page.getByTestId('permissions-save').click();
  await expect(page.getByRole('dialog', { name: 'Deploy locally' })).toBeVisible();
  await page.getByTestId('publish-confirm').click();
  await expect(page.getByRole('switch', { name: 'Active', exact: true })).toHaveAttribute('aria-checked', 'true');
  const deployed = await api<Workflow>(page, 'GET', `/api/workflows/${wf.id}`);
  expect(deployed.settings.permissions.confirmedAt).toBeTruthy();
  expect(deployed.settings.permissions.fs).toEqual([]);
});

test('engine failures are shown with their real error and persisted outcome', async ({ page }) => {
  const wf = await seed(
    page,
    {
      schemaVersion: 1,
      nodes: [
        n('t', 'core.manualTrigger', 'Start'),
        n('error', 'core.stopError', 'Intentional Failure', { message: 'Intentional Windows QA failure', code: 'QA_FAILED' }, 300),
      ],
      edges: [edge('t', 'error')],
    },
    'Failure reporting',
  );
  await page.getByTestId('run').click();
  await expect(page.getByTestId('execution-header')).toHaveAttribute('data-state', 'failed');
  await page
    .getByTestId('console')
    .getByRole('tab', { name: /Errors/ })
    .click();
  await expect(page.getByTestId('console')).toContainText('Intentional Windows QA failure');
  const runs = await api<Execution[]>(page, 'GET', `/api/executions?workflowId=${wf.id}`);
  expect(runs[0]!.state).toBe('failed');
  expect(runs[0]!.error?.message).toBe('Intentional Windows QA failure');
  await shot(page, 'studio-real-error');
});

test('restart preserves the saved workflow, SQLite execution history and sealed test credentials', async ({ page, app, dataDir }) => {
  await hello(page);
  await page.getByTestId('workflow-name').fill('Saved across restart');
  await page.getByTestId('save').click();
  await expect(page.getByTestId('save-state')).toHaveText('Saved');
  await page.getByTestId('run').click();
  await expect(page.getByTestId('execution-header')).toHaveAttribute('data-state', 'succeeded');
  await api(page, 'POST', '/api/credentials', { name: 'Isolated restart check', type: 'httpBearer', data: { token: 'qa-only-synthetic-credential' } });
  const workflowId = (await api<Execution[]>(page, 'GET', '/api/executions'))[0]!.workflowId;
  const keyFile = path.join(dataDir, process.platform === 'win32' ? 'master.key.safe' : 'master.key');
  const keyHash = crypto.createHash('sha256').update(fs.readFileSync(keyFile)).digest('hex');
  const connection = await page.evaluate(() => window.pulseflow!.connection());
  if (process.platform === 'win32') expect(connection.keyProtection).toBe('os-keychain');
  await app.close();
  const db = new DatabaseSync(path.join(dataDir, 'pulseflow.db'), { readOnly: true });
  let encrypted: unknown;
  try {
    expect(db.prepare('PRAGMA integrity_check').get()).toMatchObject({ integrity_check: 'ok' });
    expect(db.prepare('SELECT state FROM executions WHERE workflow_id=?').get(workflowId)).toMatchObject({ state: 'succeeded' });
    encrypted = db.prepare('SELECT encrypted FROM credentials WHERE name=?').get('Isolated restart check');
    expect(JSON.stringify(encrypted)).not.toContain('qa-only-synthetic-credential');
  } finally {
    db.close();
  }
  const args = [appDir, ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : [])];
  const restarted = await electron.launch({ args, env: { ...process.env, PULSEFLOW_DATA_DIR: dataDir } });
  try {
    const reopened = await restarted.firstWindow();
    await expect(reopened.getByTestId('app-ready')).toBeVisible();
    await reopened.getByTestId('workflow-row-Saved across restart').click();
    await expect(reopened.getByTestId('workflow-name')).toHaveValue('Saved across restart');
    await reopened.getByTestId('editor').getByRole('tab', { name: 'Executions', exact: true }).click();
    await expect(reopened.getByTestId('console')).toContainText('Succeeded');
    expect(crypto.createHash('sha256').update(fs.readFileSync(keyFile)).digest('hex')).toBe(keyHash);
    const creds = await api<{ name: string }[]>(reopened, 'GET', '/api/credentials');
    expect(creds.some((c) => c.name === 'Isolated restart check')).toBe(true);
    await shot(reopened, 'studio-restart-persistence');
  } finally {
    await restarted.close();
  }
  const after = new DatabaseSync(path.join(dataDir, 'pulseflow.db'), { readOnly: true });
  try {
    expect(after.prepare('SELECT encrypted FROM credentials WHERE name=?').get('Isolated restart check')).toEqual(encrypted);
  } finally {
    after.close();
  }
});

test('close hides to tray while the engine stays live; a second launch restores the window', async ({ page, app, dataDir }) => {
  const url = page.url();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible())).toBe(false);
  expect((await fetch(new URL('/api/health', url))).ok).toBe(true);
  const env = { ...process.env, PULSEFLOW_DATA_DIR: dataDir };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  // Playwright's process() is cmd.exe on Windows; ask the Electron main process for its executable.
  const executable = await app.evaluate(() => process.execPath);
  const child = spawn(executable, [appDir], { env, stdio: 'pipe' });
  let diagnostics = '';
  child.stderr?.on('data', (data) => {
    diagnostics += String(data);
  });
  const exit = new Promise<number | null>((resolve, reject) => {
    child.on('exit', resolve);
    child.on('error', reject);
  });
  try {
    await expect
      .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible()), { message: `Second launch executable: ${executable}` })
      .toBe(true)
      .catch((error) => {
        throw new Error(`${String(error)}\nChild exit: ${child.exitCode}\n${diagnostics}`);
      });
    expect(await exit).toBe(0);
    await expect(page.getByTestId('app-ready')).toBeVisible();
    await shot(page, 'studio-window-restored-from-tray');
  } finally {
    if (child.exitCode === null) child.kill();
  }
});
