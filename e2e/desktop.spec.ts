import fs from 'node:fs';
import path from 'node:path';
import { expect, shot, test } from './fixtures';

test('renderer is isolated from Node and only sees the allow-listed bridge', async ({ page }) => {
  const probe = await page.evaluate(() => ({
    require: typeof (window as unknown as { require?: unknown }).require,
    process: typeof (window as unknown as { process?: unknown }).process,
    bridgeKeys: Object.keys((window as unknown as { pulseflow?: object }).pulseflow ?? {}).sort(),
  }));
  expect(probe.require).toBe('undefined');
  expect(probe.process).toBe('undefined');
  expect(probe.bridgeKeys).toEqual(['connection', 'onNavigate', 'openExternal', 'selectFile', 'selectFolder', 'setKeepInTray', 'showItemInFolder']);
  const csp = await page.evaluate(async () => (await fetch('/')).headers.get('content-security-policy'));
  expect(csp).toContain("script-src 'self'");
  await expect(page.getByTestId('workflows-page')).toBeVisible();
  await shot(page, '01-workflows-empty');
});

test('offline template: Hello Automation runs end-to-end from the gallery', async ({ page, dataDir }) => {
  await page.getByTestId('nav-templates').click();
  await expect(page.getByTestId('template-card-A01')).toBeVisible();
  await shot(page, '02-templates-gallery');
  await page.getByTestId('template-card-A01').click();
  await expect(page.getByTestId('template-dialog')).toBeVisible();
  await expect(page.getByTestId('template-permissions')).toContainText('Write files');
  await page.getByTestId('template-use').click();

  await expect(page.getByTestId('editor')).toBeVisible();
  await expect(page.getByTestId('node-Build Greeting')).toBeVisible();
  await expect(page.getByTestId('validation')).toHaveText(/Valid/);
  await page.getByTestId('run').click();
  await expect(page.getByTestId('execution-header')).toHaveAttribute('data-state', 'succeeded', { timeout: 30_000 });
  await expect(page.getByTestId('timeline-row-Save Greeting')).toHaveAttribute('data-state', 'succeeded');
  await expect(page.getByTestId('timeline-row-Log Empty Name')).toHaveAttribute('data-state', 'skipped');
  await expect(page.getByTestId('node-Notify')).toHaveAttribute('data-state', 'succeeded');
  await shot(page, '03-editor-run-succeeded');

  const written = fs
    .readdirSync(path.join(dataDir, 'demo', 'templates'), { recursive: true })
    .map(String)
    .find((f) => f.endsWith('hello-pulseflow.json'));
  expect(written).toBeTruthy();
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'demo', 'templates', written!), 'utf8')) as { greeting: string };
  expect(saved.greeting).toMatch(/^Hello, PulseFlow!/);

  await page.getByRole('tab', { name: /Node IO/ }).click();
  await page.getByTestId('node-io').getByRole('button', { name: 'Build Greeting' }).click();
  await expect(page.getByTestId('node-io')).toContainText('Hello, PulseFlow!');
  await shot(page, '04-console-node-io');
});

test('build a workflow from scratch on the canvas, run it, and see item data', async ({ page }) => {
  await page.getByTestId('new-workflow').click();
  await expect(page.getByTestId('empty-canvas')).toBeVisible();
  await page.getByTestId('empty-canvas').getByRole('button', { name: 'Manual Trigger' }).click();
  await expect(page.getByTestId('node-Manual Trigger')).toBeVisible();

  await page.getByTestId('add-node').click();
  await page.getByTestId('library-search').fill('set fields');
  await page.getByTestId('library-item-core.set').click();
  await expect(page.getByTestId('node-Set Fields')).toBeVisible();

  const inspector = page.getByTestId('inspector');
  await inspector.getByRole('button', { name: 'Add row' }).click();
  await inspector.getByPlaceholder('Name').fill('message');
  await inspector.getByPlaceholder('Value').fill('Built at {{ $now }}');

  await page.getByTestId('workflow-name').fill('Canvas smoke test');
  await expect(page.getByTestId('save-state')).toHaveText(/Saved/, { timeout: 10_000 });
  await page.keyboard.press('Control+Enter');
  await expect(page.getByTestId('execution-header')).toHaveAttribute('data-state', 'succeeded', { timeout: 30_000 });
  await page.getByRole('tab', { name: /Node IO/ }).click();
  await page.getByTestId('node-io').getByRole('button', { name: 'Set Fields' }).click();
  await expect(page.getByTestId('node-io')).toContainText('Built at 20');
  await shot(page, '05-built-from-scratch');

  await page.getByTestId('nav-workflows').click();
  await expect(page.getByTestId('workflow-row-Canvas smoke test')).toBeVisible();
});

test('connected template demo mode talks only to the local fixture server', async ({ page }) => {
  await page.getByTestId('nav-templates').click();
  await page.getByRole('tab', { name: /Connected/ }).click();
  await expect(page.getByTestId('template-planned-B08')).toContainText('Planned');
  await page.getByTestId('template-card-B01').click();
  await expect(page.getByTestId('mode-try-demo')).toBeVisible();
  await page.getByTestId('mode-try-demo').click();
  await expect(page.getByTestId('demo-network-note')).toContainText('127.0.0.1');
  await shot(page, '06-tier-b-demo-dialog');
  await page.getByTestId('template-use').click();
  await expect(page.getByTestId('editor')).toBeVisible();
  await page.getByTestId('run').click();
  await expect(page.getByTestId('execution-header')).toHaveAttribute('data-state', 'succeeded', { timeout: 30_000 });
  await page.getByTestId('console').getByRole('tab', { name: /Logs/ }).click();
  await expect(page.getByTestId('logs')).toContainText('release-digest.md');
  await page
    .getByTestId('canvas')
    .locator('.react-flow__pane')
    .click({ position: { x: 20, y: 20 } });
  await expect(page.getByTestId('variables')).toContainText('apiBaseUrl');
  const apiBase = await page.getByTestId('var-apiBaseUrl').inputValue();
  expect(apiBase).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/demo\/github$/);
  await shot(page, '07-tier-b-demo-run');
});

test('credentials are write-only in the UI', async ({ page }) => {
  await page.getByTestId('nav-credentials').click();
  await page.getByTestId('credential-type').selectOption('httpBearer');
  await page.getByRole('button', { name: 'Add credential' }).click();
  await page.getByTestId('credential-field-token').fill('super-secret-token-value-123');
  await page.getByTestId('credential-save').click();
  await expect(page.getByTestId('credentials-page')).toContainText('encrypted');
  await expect(page.getByTestId('credentials-page')).not.toContainText('super-secret-token-value-123');
  const apiBody = await page.evaluate(async () => {
    const info = await (window as unknown as { pulseflow: { connection(): Promise<{ token: string }> } }).pulseflow.connection();
    return (await fetch('/api/credentials', { headers: { authorization: `Bearer ${info.token}` } })).text();
  });
  expect(apiBody).not.toContain('super-secret-token-value-123');
  await shot(page, '08-credentials');
});

test('executions page and command palette', async ({ page }) => {
  await page.getByTestId('nav-templates').click();
  await page.getByTestId('template-card-A01').click();
  await page.getByTestId('template-use').click();
  await page.getByTestId('run').click();
  await expect(page.getByTestId('execution-header')).toHaveAttribute('data-state', 'succeeded', { timeout: 30_000 });
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('command-palette')).toBeVisible();
  await page.keyboard.type('Go to Executions');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('executions-page')).toContainText('Hello Automation');
  await page
    .getByTestId('executions-page')
    .getByRole('button', { name: /Hello Automation/ })
    .first()
    .click();
  await expect(page.getByTestId('executions-page')).toContainText('Save Greeting');
  await page.getByRole('tab', { name: 'Dead letters' }).click();
  await expect(page.getByTestId('executions-page')).toContainText('No dead letters');
  await expect(page.getByTestId('executions-page')).toContainText('the payload comes back here');
  await shot(page, '09-executions');
  await page.getByTestId('nav-settings').click();
  await expect(page.getByTestId('about')).toContainText('PulseFlow sends no usage data');
  await shot(page, '10-settings');
});
