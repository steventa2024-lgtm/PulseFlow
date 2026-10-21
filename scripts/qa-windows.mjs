// Native crash-recovery QA. Run after `pnpm build` on an interactive Windows desktop.
// When READY_FOR_NATIVE_RESTART appears, click the real native "Restart engine" dialog.
// --accept-restart automates only the dialog decision; its native button interaction remains NOT TESTED.
// All data is isolated under artifacts/native-windows; no production profile is opened.
/* global window */
import { _electron as electron, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

if (process.platform !== 'win32') throw new Error('This QA requires a real Windows desktop');
const out = path.resolve('artifacts/native-windows');
fs.mkdirSync(out, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(out, 'isolated-data-'));
const results = [];
const record = (test, status, details) => {
  results.push({ test, status, details });
  fs.writeFileSync(
    path.join(out, 'results.json'),
    JSON.stringify({ platform: process.platform, generatedAt: new Date().toISOString(), dataDir, results }, null, 2),
  );
  console.log(`${status}: ${test}`);
};
const application = await electron.launch({ args: [path.resolve('apps/desktop')], env: { ...process.env, PULSEFLOW_DATA_DIR: dataDir }, timeout: 60000 });
try {
  const page = await application.firstWindow();
  await expect(page.getByTestId('app-ready')).toBeVisible();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
  const api = (method, url, body) =>
    page.evaluate(
      async ({ method, url, body }) => {
        const { token } = await window.pulseflow.connection();
        const response = await fetch(url, {
          method,
          headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        if (!response.ok) throw new Error(`${method} ${url}: ${response.status}`);
        return response.json();
      },
      { method, url, body },
    );
  record(
    'Desktop startup',
    'PASS',
    await page.evaluate(async () => {
      const info = await window.pulseflow.connection();
      return { platform: info.platform, keyProtection: info.keyProtection, versions: info.versions };
    }),
  );
  const n = (id, type, name, parameters, x) => ({ id, type, typeVersion: 1, name, parameters, position: { x, y: 100 } });
  const e = (source, target) => ({ id: `${source}-${target}`, source, target, sourcePort: 'main', targetPort: 'main' });
  const create = async (name, seconds) =>
    api('POST', '/api/workflows', {
      name,
      draft: {
        schemaVersion: 1,
        nodes: [
          n('t', 'core.manualTrigger', 'Start', {}, 0),
          n('wait', 'core.wait', `Wait ${seconds}s`, { amount: seconds, unit: 'seconds' }, 300),
          n('done', 'core.set', 'Recovery Result', { fields: [{ name: 'recovered', value: '{{ true }}' }] }, 600),
        ],
        edges: [e('t', 'wait'), e('wait', 'done')],
      },
    });
  const durable = await create('Native durable recovery', 45);
  const waiting = await api('POST', `/api/workflows/${durable.id}/run`, {});
  await expect.poll(async () => (await api('GET', `/api/executions/${waiting.executionId}`)).state).toBe('waiting');
  const inline = await create('Native interrupted run', 5);
  const interrupted = await api('POST', `/api/workflows/${inline.id}/run`, {});
  await expect.poll(async () => (await api('GET', `/api/executions/${interrupted.executionId}`)).state).toBe('running');
  await page.evaluate((id) => {
    window.location.hash = `/workflows/${id}`;
  }, inline.id);
  await expect(page.getByTestId('editor')).toBeVisible();
  const metrics = await application.evaluate(({ app }) => app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type, name: m.name })));
  const host = metrics.find((m) => m.name === 'PulseFlow Host');
  if (!host) throw new Error(`Could not identify the dedicated host process: ${JSON.stringify(metrics)}`);
  if (process.argv.includes('--accept-restart')) {
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    });
    record(
      'Native restart dialog button interaction',
      'NOT TESTED',
      'Restart choice accepted by the QA harness. The actual native dialog was observed in the manual attempt, but an unrelated topmost window blocked automation.',
    );
  }
  record('Durable wait persisted before crash', 'PASS', { executionId: waiting.executionId, hostPid: host.pid });
  fs.writeFileSync(
    path.join(out, 'phase.json'),
    JSON.stringify({ phase: 'awaiting-native-restart-dialog', hostPid: host.pid, mainPid: await application.evaluate(() => process.pid) }),
  );
  process.kill(host.pid, 'SIGKILL');
  console.log('READY_FOR_NATIVE_RESTART — use the real Windows dialog to restart the engine.');
  await page.waitForEvent('load', { timeout: 180000 });
  await expect(page.getByTestId('app-ready')).toBeVisible();
  const crashed = await api('GET', `/api/executions/${interrupted.executionId}`);
  if (crashed.state !== 'failed' || crashed.error?.code !== 'INTERRUPTED')
    throw new Error(`Interrupted run recovery failed: ${JSON.stringify({ state: crashed.state, error: crashed.error })}`);
  record('Actual utility-process crash and engine restart', 'PASS', {
    interruptedState: crashed.state,
    errorCode: crashed.error.code,
    restartChoice: process.argv.includes('--accept-restart') ? 'QA harness accepted dialog decision' : 'native dialog',
  });
  await page.evaluate((id) => {
    window.location.hash = `/workflows/${id}`;
  }, inline.id);
  await expect(page.getByTestId('workflow-name')).toHaveValue('Native interrupted run');
  await page.getByTestId('editor').getByRole('tab', { name: 'Executions', exact: true }).click();
  await page.screenshot({ path: path.join(out, 'native-interrupted-run.png') });
  await expect.poll(async () => (await api('GET', `/api/executions/${waiting.executionId}`)).state, { timeout: 75000 }).toBe('succeeded');
  const resumed = await api('GET', `/api/executions/${waiting.executionId}`);
  if (!resumed.steps.find((s) => s.nodeId === 'done')?.output?.main?.[0]?.json.recovered)
    throw new Error('Durable wait did not execute its real downstream step');
  record('Durable wait resumed across native host crash', 'PASS', { executionId: waiting.executionId, state: resumed.state });
  await page.evaluate((id) => {
    window.location.hash = `/workflows/${id}`;
  }, durable.id);
  await expect(page.getByTestId('workflow-name')).toHaveValue('Native durable recovery');
  await page.getByTestId('editor').getByRole('tab', { name: 'Executions', exact: true }).click();
  await page.screenshot({ path: path.join(out, 'native-durable-recovery.png') });
  fs.writeFileSync(path.join(out, 'phase.json'), JSON.stringify({ phase: 'complete' }));
} catch (error) {
  record('Native recovery QA', 'FAIL', String(error));
  throw error;
} finally {
  await application.close();
}
