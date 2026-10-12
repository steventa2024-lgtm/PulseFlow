import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually } from '@pulseflow/testing';
import { instantiate, runTemplate, runWorkflow, stepSummary, withFiles, startTestHost, type TestHost } from '../helpers';

let host: TestHost;
beforeAll(async () => {
  host = await startTestHost();
});
afterAll(async () => {
  await host.dispose();
});

const listFiles = (dir: string): string[] =>
  fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join('/')).sort() : [];

async function setVariables(workflowId: string, variables: Record<string, unknown>) {
  const wf = await host.api<{ settings: { variables: Record<string, unknown> } }>('GET', `/api/workflows/${workflowId}`);
  const res = await host.api('PATCH', `/api/workflows/${workflowId}`, { settings: { variables: { ...wf.body.settings.variables, ...variables } } });
  expect(res.status).toBe(200);
}

const notifications = async () => (await host.api<{ title: string; body: string; workflow_id: string }[]>('GET', '/api/notifications')).body;

describe('Tier A templates (offline, end-to-end)', () => {
  it('A01 Hello Automation writes the greeting and notifies', async () => {
    const r = await runTemplate(host, 'A01');
    expect(r.execution.state, stepSummary(r.steps)).toBe('succeeded');
    const out = JSON.parse(r.file('output/hello-pulseflow.json')) as { greeting: string; hasName: boolean };
    expect(out.greeting).toMatch(/^Hello, PulseFlow! Your first automation ran at \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.$/);
    expect(out.hasName).toBe(true);
    expect((await notifications()).some((n) => n.workflow_id === r.workflowId && n.body.includes('hello-pulseflow.json'))).toBe(true);
  });

  it('A01 failure path: empty name writes nothing and logs why', async () => {
    const r = await runTemplate(host, 'A01', { run: { items: [{ json: { name: '' } }] } });
    expect(r.execution.state).toBe('succeeded');
    expect(r.step('log')?.state).toBe('succeeded');
    expect(r.step('save')?.state).toBe('skipped');
    expect(listFiles(path.join(r.templateDir, 'output'))).toEqual([]);
  });

  it('A02 Downloads Organizer sorts demo files without overwriting and writes an undo manifest', async () => {
    const { workflowId, templateDir } = await instantiate(host, 'A02');
    const { execution, steps } = await runWorkflow(host, workflowId, { triggerNodeId: 'watch' });
    expect(execution.state, stepSummary(steps)).toBe('succeeded');
    const organized = listFiles(path.join(templateDir, 'organized'));
    expect(organized).toEqual(expect.arrayContaining(['Images/holiday.jpg', 'Images/holiday (1).jpg', 'Documents/invoice.pdf', 'Documents/notes.txt', 'Archives/backup.zip', 'Other/tool.exe-not', 'undo-manifest.ndjson']));
    expect(fs.readFileSync(path.join(templateDir, 'organized/Images/holiday.jpg'), 'utf8')).toContain('existing file');
    expect(listFiles(path.join(templateDir, 'incoming'))).toEqual([]);
    const manifest = fs.readFileSync(path.join(templateDir, 'organized/undo-manifest.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { from: string; to: string });
    expect(manifest).toHaveLength(5);
    expect(manifest.every((m) => m.from.includes('incoming') && fs.existsSync(m.to))).toBe(true);
  });

  it('A02 watches the folder when active and moves only settled new files', async () => {
    const { workflowId, templateDir } = await instantiate(host, 'A02');
    for (const f of fs.readdirSync(path.join(templateDir, 'incoming'))) fs.rmSync(path.join(templateDir, 'incoming', f));
    expect((await host.api('POST', `/api/workflows/${workflowId}/activate`, {})).status).toBe(200);
    await new Promise((r) => setTimeout(r, 500));
    fs.writeFileSync(path.join(templateDir, 'incoming', 'new-photo.png'), 'png');
    await eventually(() => fs.existsSync(path.join(templateDir, 'organized/Images/new-photo.png')), { timeoutMs: 15_000 });
    await host.api('POST', `/api/workflows/${workflowId}/deactivate`, {});
  }, 30_000);

  it('A03 Batch File Renamer previews by default, then renames on confirm', async () => {
    const r = await runTemplate(host, 'A03');
    expect(r.execution.state, stepSummary(r.steps)).toBe('succeeded');
    const before = listFiles(path.join(r.templateDir, 'photos'));
    expect(before).toEqual(['IMG 0003.jpg', 'IMG_0001.JPG', 'img-0002.jpeg', 'trip-002.jpeg']);
    const preview = JSON.parse(r.file('rename-manifest.json')) as { preview: boolean; pairs: { from: string; to: string; action: string }[] };
    expect(preview.preview).toBe(true);
    expect(preview.pairs).toHaveLength(4);

    await setVariables(r.workflowId, { confirm: true });
    const run2 = withFiles({ ...(await runWorkflow(host, r.workflowId)), workflowId: r.workflowId, templateDir: r.templateDir });
    expect(run2.execution.state, stepSummary(run2.steps)).toBe('succeeded');
    const after = listFiles(path.join(r.templateDir, 'photos'));
    expect(after).toHaveLength(4);
    expect(after.every((f) => /^trip-\d{3}( \(\d\))?\.(jpg|JPG|jpeg)$/.test(f))).toBe(true);
    const manifest = JSON.parse(run2.file('rename-manifest.json')) as { preview: boolean; pairs: { from: string; to: string }[] };
    expect(manifest.preview).toBe(false);
    expect(new Set(manifest.pairs.map((p) => p.to)).size).toBe(4);
  });

  it('A04 CSV to JSON preserves quotes, Unicode and embedded newlines and types numbers', async () => {
    const r = await runTemplate(host, 'A04');
    expect(r.execution.state, stepSummary(r.steps)).toBe('succeeded');
    const rows = JSON.parse(r.file('products.json')) as { sku: string; name: string; price: number; quantity: number; notes: string; inStock: boolean }[];
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ sku: 'A-1', name: 'Café crème', price: 3.5, quantity: 10, notes: 'Contains "milk", sugar', inStock: true });
    expect(rows[1]).toMatchObject({ name: '日本茶', notes: 'Line one\nLine two' });
    expect(rows[2]).toMatchObject({ name: 'Widget, large', price: 12, inStock: false });
  });

  it('A04 failure path: a missing input file fails with a clear error', async () => {
    const { workflowId } = await instantiate(host, 'A04');
    await setVariables(workflowId, { inputFile: path.join(host.ctx.config.demoDir, 'nope.csv') });
    const { execution } = await runWorkflow(host, workflowId);
    expect(execution.state).toBe('failed');
    expect(execution.error?.message).toMatch(/nope\.csv|not found|ENOENT/i);
  });

  it('A05 JSON to CSV escapes cells and neutralizes formulas', async () => {
    const r = await runTemplate(host, 'A05');
    expect(r.execution.state, stepSummary(r.steps)).toBe('succeeded');
    const csv = r.file('orders-report.csv');
    expect(csv.split(/\r?\n/)[0]).toBe('order_id,customer,email,total,note');
    expect(csv).toContain('"Grace ""Amazing"" Hopper"');
    expect(csv).toContain('"Leave at\ndoor"');
    expect(csv).toContain(`"'=HYPERLINK(""http://example.com"")"`);
    expect(csv).toContain('1001,Ada Lovelace,ada@example.com,42.5,"Gift wrap, please"');
  });

  it('A06 Duplicate Finder reports identical files and deletes nothing', async () => {
    const r = await runTemplate(host, 'A06');
    expect(r.execution.state, stepSummary(r.steps)).toBe('succeeded');
    const report = r.file('duplicates-report.md');
    expect(report).toContain('**3 identical files**');
    expect(report).toContain('**2 identical files**');
    expect(report).toMatch(/a\/song\.mp3/);
    expect(report).not.toContain('photo.png');
    expect(report).not.toContain('same-size-different');
    expect(listFiles(path.join(r.templateDir, 'library'))).toHaveLength(7);
  });

  it('A07 Scheduled Desktop Reminder arms a weekday 09:00 schedule and notifies + logs when fired', async () => {
    const { workflowId, templateDir } = await instantiate(host, 'A07');
    await host.api('PATCH', `/api/workflows/${workflowId}`, { settings: { timezone: 'Europe/Berlin' } });
    expect((await host.api('POST', `/api/workflows/${workflowId}/activate`, {})).status).toBe(200);
    const triggers = await host.api<{ nextRunAt?: string }[]>('GET', `/api/workflows/${workflowId}/triggers`);
    const next = new Date(triggers.body[0]!.nextRunAt!);
    const local = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(next);
    expect(local).toMatch(/^(Mon|Tue|Wed|Thu|Fri) 09:00$/);
    await host.api('POST', `/api/workflows/${workflowId}/deactivate`, {});
    const { execution, steps } = await runWorkflow(host, workflowId, { triggerNodeId: 'schedule' });
    expect(execution.state, stepSummary(steps)).toBe('succeeded');
    expect(fs.readFileSync(path.join(templateDir, 'reminders.log'), 'utf8')).toContain('Stand up, stretch and drink some water.');
    expect((await notifications()).some((n) => n.workflow_id === workflowId && n.title === 'Reminder')).toBe(true);
  });

  it('A08 Folder Backup copies, verifies checksums and never overwrites', async () => {
    const r = await runTemplate(host, 'A08');
    expect(r.execution.state, stepSummary(r.steps)).toBe('succeeded');
    const day = fs.readdirSync(path.join(r.templateDir, 'backups'))[0]!;
    expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const files = listFiles(path.join(r.templateDir, 'backups', day));
    expect(files).toEqual(['backup-manifest.json', 'budget.csv', 'photos/cat.txt', 'plan.md']);
    expect(fs.readFileSync(path.join(r.templateDir, 'backups', day, 'plan.md'), 'utf8')).toBe(fs.readFileSync(path.join(r.templateDir, 'documents/plan.md'), 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(path.join(r.templateDir, 'backups', day, 'backup-manifest.json'), 'utf8')) as { count: number; files: { sha256: string; backupSha256: string }[] };
    expect(manifest.count).toBe(3);
    expect(manifest.files.every((f) => f.sha256 === f.backupSha256)).toBe(true);
    fs.writeFileSync(path.join(r.templateDir, 'backups', day, 'plan.md'), '# Plan\n\n- backup things\n');
    const again = await runWorkflow(host, r.workflowId);
    expect(again.execution.state, stepSummary(again.steps)).toBe('succeeded');
    expect(again.steps.find((s) => s.nodeId === 'copy')?.output?.main?.every((i) => i.json.action === 'skipped')).toBe(true);
  });

  it('A08 failure path: a changed backup copy fails verification', async () => {
    const r = await runTemplate(host, 'A08');
    const day = fs.readdirSync(path.join(r.templateDir, 'backups'))[0]!;
    fs.writeFileSync(path.join(r.templateDir, 'backups', day, 'plan.md'), 'tampered');
    const again = await runWorkflow(host, r.workflowId);
    expect(again.execution.state).toBe('failed');
    expect(again.execution.error?.code).toBe('CHECKSUM_MISMATCH');
  });

  it('A09 Markdown Daily Report summarizes revenue by region', async () => {
    const r = await runTemplate(host, 'A09');
    expect(r.execution.state, stepSummary(r.steps)).toBe('succeeded');
    const reports = listFiles(path.join(r.templateDir, 'reports'));
    expect(reports).toHaveLength(1);
    const md = fs.readFileSync(path.join(r.templateDir, 'reports', reports[0]!), 'utf8');
    expect(md).toContain('# Daily Sales Report');
    expect(md).toContain('| West | 1 | 210 |');
    expect(md).toContain('| North | 2 | 150.75 |');
    expect(md).toContain('| South | 2 | 99.99 |');
    expect(md.indexOf('West')).toBeLessThan(md.indexOf('North'));
  });

  it('A10 Local Webhook Intake validates, appends NDJSON and replies 200 / 422', async () => {
    const { workflowId, templateDir } = await instantiate(host, 'A10');
    expect((await host.api('POST', `/api/workflows/${workflowId}/activate`, {})).status).toBe(200);
    const triggers = await host.api<{ webhookUrl: string }[]>('GET', `/api/workflows/${workflowId}/triggers`);
    const url = triggers.body[0]!.webhookUrl;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/hooks\/[A-Za-z0-9_-]{24,}$/);
    const ok = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Ada', email: 'ada@example.com', message: 'Hi' }) });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true });
    const bad = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '', email: 'not-an-email', admin: true }) });
    expect(bad.status).toBe(422);
    const badBody = (await bad.json()) as { ok: boolean; errors: { path: string }[] };
    expect(badBody.ok).toBe(false);
    expect(badBody.errors.map((e) => e.path)).toEqual(expect.arrayContaining(['$.name', '$.email', '$.admin']));
    const lines = fs.readFileSync(path.join(templateDir, 'submissions.ndjson'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ name: 'Ada', email: 'ada@example.com', message: 'Hi' });
    await host.api('POST', `/api/workflows/${workflowId}/deactivate`, {});
  });

  it('A11 Website Response Monitor records a baseline, then notifies on change', async () => {
    host.ctx.fixtureState.monitorStatus = 200;
    const r = await runTemplate(host, 'A11');
    expect(r.execution.state, stepSummary(r.steps)).toBe('succeeded');
    expect(r.step('same')?.state).toBe('succeeded');
    expect(r.exists('monitor.log')).toBe(false);
    await fetch(`${host.url}/demo/monitor/state?status=503`, { method: 'POST' });
    const changed = await runWorkflow(host, r.workflowId);
    expect(changed.execution.state, stepSummary(changed.steps)).toBe('succeeded');
    expect(r.file('monitor.log')).toMatch(/200 -> 503/);
    expect((await notifications()).some((n) => n.workflow_id === r.workflowId && n.body.includes('200 → 503'))).toBe(true);
    const same = await runWorkflow(host, r.workflowId);
    expect(same.steps.find((s) => s.nodeId === 'notify')?.state).toBe('skipped');
    host.ctx.fixtureState.monitorStatus = 200;
  });

  it('A12 API Health Check reports healthy, slow (timeout) and failing endpoints', async () => {
    const r = await runTemplate(host, 'A12');
    expect(r.execution.state, stepSummary(r.steps)).toBe('succeeded');
    const lines = r.file('health-report.csv').trim().split(/\r?\n/);
    expect(lines[0]).toBe('endpoint,status,ok,latencyMs,error,checkedAt');
    expect(lines).toHaveLength(4);
    const byPath = (p: string) => lines.find((l) => l.includes(p))!;
    expect(byPath('/api/health')).toMatch(/,200,true,/);
    expect(byPath('/api/slow')).toMatch(/,0,false,.*(timed out|timeout)/i);
    expect(byPath('/api/error')).toMatch(/,(500|0),false,/);
    expect((await notifications()).some((n) => n.workflow_id === r.workflowId && n.body.startsWith('2 endpoint(s) unhealthy'))).toBe(true);
  });

  it('A13 Log Keyword Watch alerts only on new matching lines', async () => {
    const { workflowId, templateDir } = await instantiate(host, 'A13');
    expect((await host.api('POST', `/api/workflows/${workflowId}/activate`, {})).status).toBe(200);
    await new Promise((r) => setTimeout(r, 700));
    fs.appendFileSync(path.join(templateDir, 'app.log'), '2026-01-05T09:01:00Z INFO all good\n2026-01-05T09:02:00Z ERROR database unreachable\n2026-01-05T09:03:00Z FATAL out of memory\n');
    const alerts = await eventually(() => {
      const f = path.join(templateDir, 'alerts.log');
      const t = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
      return t.split('\n').filter(Boolean).length >= 2 ? t : null;
    }, { timeoutMs: 15_000 });
    expect(alerts).toContain('ERROR database unreachable');
    expect(alerts).toContain('FATAL out of memory');
    expect(alerts).not.toContain('INFO');
    expect(alerts).not.toContain('service started');
    expect((await notifications()).some((n) => n.workflow_id === workflowId && n.body.startsWith('2 matching line(s)'))).toBe(true);
    await host.api('POST', `/api/workflows/${workflowId}/deactivate`, {});
  }, 30_000);

  it('A14 Personal Task Digest lists open tasks due soon, overdue first', async () => {
    const r = await runTemplate(host, 'A14');
    expect(r.execution.state, stepSummary(r.steps)).toBe('succeeded');
    const digests = listFiles(path.join(r.templateDir, 'digests'));
    expect(digests).toHaveLength(1);
    const md = fs.readFileSync(path.join(r.templateDir, 'digests', digests[0]!), 'utf8');
    const items = md.split('\n').filter((l) => l.startsWith('- [ ]'));
    expect(items.map((l) => /\*\*(.+?)\*\*/.exec(l)![1])).toEqual(['Call grandma', 'Pay electricity bill', 'Renew passport']);
    expect(items[0]).toContain('(overdue)');
    expect(items[2]).toContain('high priority');
    expect(md).not.toContain('Book dentist');
    expect(md).not.toContain('Submit expense report');
  });

  it('A15 RSS to Reading List saves each entry exactly once', async () => {
    const r = await runTemplate(host, 'A15');
    expect(r.execution.state, stepSummary(r.steps)).toBe('succeeded');
    const lines = () => r.file('reading-list.md').trim().split('\n');
    expect(lines()).toHaveLength(3);
    expect(lines()[0]).toMatch(/^- \[Safe expression languages\]\(http:\/\/127\.0\.0\.1:\d+\/demo\/articles\/demo-3\) — 2026-01-03$/);
    await runWorkflow(host, r.workflowId);
    expect(lines()).toHaveLength(3);
    await setVariables(r.workflowId, { feedUrl: `${host.ctx.fixturesUrl()}/feed.xml?variant=2` });
    await runWorkflow(host, r.workflowId);
    expect(lines()).toHaveLength(4);
    expect(lines()[3]).toContain('Durable timers explained');
  });

  it('A16 Error Recovery Example fails twice then succeeds with exponential backoff', async () => {
    const r = await runTemplate(host, 'A16');
    expect(r.execution.state, stepSummary(r.steps)).toBe('succeeded');
    const attempts = r.steps.filter((s) => s.nodeId === 'flaky');
    expect(attempts.map((s) => [s.attempt, s.state])).toEqual([
      [1, 'retrying'],
      [2, 'retrying'],
      [3, 'succeeded'],
    ]);
    expect(attempts.slice(0, 2).map((s) => s.retryInMs)).toEqual([500, 1000]);
    expect(r.file('recovery.log')).toMatch(/recovered on call 3\n$/);
  });

  it('A16 failure path: more failures than attempts ends in a clear failure', async () => {
    const r = await runTemplate(host, 'A16', { variables: { failures: 6 } });
    expect(r.execution.state).toBe('failed');
    expect(r.execution.error?.code).toBe('HTTP_503');
    expect(r.steps.filter((s) => s.nodeId === 'flaky')).toHaveLength(4);
    expect(r.exists('recovery.log')).toBe(false);
  }, 30_000);
});
