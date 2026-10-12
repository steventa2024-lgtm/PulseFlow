import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLANNED_TEMPLATES, TIER_B } from '@pulseflow/templates';
import { instantiate, runTemplate, runWorkflow, stepSummary, startTestHost, type TestHost } from '../helpers';

let host: TestHost;
beforeAll(async () => {
  host = await startTestHost();
});
afterAll(async () => {
  await host.dispose();
});

describe('Tier B templates — demo mode (bundled fixtures, clearly labelled)', () => {
  it('every Tier B template declares live requirements and a demo mode', () => {
    for (const t of TIER_B) {
      expect(t.liveRequirements, t.id).toBeTruthy();
      expect(t.demoOverrides, t.id).toBeTruthy();
    }
    expect(PLANNED_TEMPLATES.every((p) => p.status === 'planned')).toBe(true);
  });

  it('demo workflows are named and tagged as demo', async () => {
    const { workflowId } = await instantiate(host, 'B01', { demo: true });
    const wf = await host.api<{ name: string; tags: string[] }>('GET', `/api/workflows/${workflowId}`);
    expect(wf.body.name).toMatch(/\(demo\)$/);
    expect(wf.body.tags).toContain('demo');
  });

  it('B01 GitHub Release Digest paginates the fixture and writes the 10 newest releases', async () => {
    const r = await runTemplate(host, 'B01', { demo: true });
    expect(r.execution.state, stepSummary(r.steps)).toBe('succeeded');
    const lines = r
      .file('release-digest.md')
      .split('\n')
      .filter((l) => l.startsWith('- '));
    expect(lines).toHaveLength(10);
    expect(lines[0]).toContain('**v1.12.0**');
    expect(lines[9]).toContain('**v1.3.0**');
  });

  it('B02 RSS to Discord posts each new entry once', async () => {
    const before = host.ctx.fixtureState.discord.length;
    const r = await runTemplate(host, 'B02', { demo: true });
    expect(r.execution.state, stepSummary(r.steps)).toBe('succeeded');
    const posted = host.ctx.fixtureState.discord.slice(before);
    expect(posted).toHaveLength(3);
    expect(posted[0]!.content).toMatch(/^\*\*Safe expression languages\*\*\nhttp:\/\/127\.0\.0\.1/);
    await runWorkflow(host, r.workflowId);
    expect(host.ctx.fixtureState.discord.length - before).toBe(3);
  });

  it('B03 Website Monitor → Telegram alerts on down and on recovery', async () => {
    host.ctx.fixtureState.monitorStatus = 200;
    const before = host.ctx.fixtureState.telegram.length;
    const r = await runTemplate(host, 'B03', { demo: true });
    expect(r.execution.state, stepSummary(r.steps)).toBe('succeeded');
    expect(host.ctx.fixtureState.telegram.length).toBe(before);
    host.ctx.fixtureState.monitorStatus = 503;
    await runWorkflow(host, r.workflowId);
    host.ctx.fixtureState.monitorStatus = 200;
    await runWorkflow(host, r.workflowId);
    const sent = host.ctx.fixtureState.telegram.slice(before);
    expect(sent.map((m) => m.text.split(':')[0])).toEqual(['DOWN', 'RECOVERED']);
    expect(sent[0]!.chatId).toBe('424242');
    expect(sent[0]!.text).toContain('(503)');
  });

  it('B04 Daily Email Digest sends through the local SMTP sink only', async () => {
    const before = host.ctx.fixtureState.smtp.length;
    const r = await runTemplate(host, 'B04', { demo: true });
    expect(r.execution.state, stepSummary(r.steps)).toBe('succeeded');
    const mail = host.ctx.fixtureState.smtp.slice(before);
    expect(mail).toHaveLength(1);
    expect(mail[0]!.to).toEqual(['me@example.com']);
    const subject = /^Subject: (.+(?:\n[ \t].+)*)/m.exec(mail[0]!.data)![1]!.replace(/\n[ \t]/g, '');
    const decoded = subject
      .replace(/=\?UTF-8\?Q\?(.*?)\?=/gi, (_, q: string) =>
        Buffer.from(
          q.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16))),
          'latin1',
        ).toString('utf8'),
      )
      .replace(/\?=\s*=\?UTF-8\?Q\?/gi, '');
    expect(decoded).toMatch(/Task digest — \d{4}-\d{2}-\d{2} \(2 open\)/);
    expect(mail[0]!.data).toContain('Water the plants');
    expect(mail[0]!.data).not.toContain('File taxes');
  });

  it('B05 Webhook Form → Google Sheets appends RAW rows to the fixture', async () => {
    const r = await runTemplate(host, 'B05', { demo: true, run: { triggerNodeId: 'manual' } });
    expect(r.execution.state, stepSummary(r.steps)).toBe('succeeded');
    expect(r.step('result')?.output?.main?.[0]?.json).toMatchObject({ ok: true, updatedRange: 'Sheet1!A1:D1' });
    const rows = host.ctx.fixtureState.sheets.get('demo-sheet')!;
    expect(rows.at(-1)!.slice(1)).toEqual(['Ada', 'ada@example.com', 'Hello from PulseFlow']);
  });

  it('B06 Local AI Note Summarizer labels fixture output as not-AI', async () => {
    const r = await runTemplate(host, 'B06', { demo: true });
    expect(r.execution.state, stepSummary(r.steps)).toBe('succeeded');
    const md = r.file('summaries.md');
    expect(md).toContain('## ideas.md');
    expect(md).toContain('## meeting.md');
    expect(md.match(/\[Demo fixture, not an AI model\]/g)).toHaveLength(2);
    expect(md).toContain('We agreed to ship the beta on Friday.');
  });

  it('B07 GitHub Issue Triage classifies issues (PRs excluded) into a CSV', async () => {
    const r = await runTemplate(host, 'B07', { demo: true });
    expect(r.execution.state, stepSummary(r.steps)).toBe('succeeded');
    const rows = r.file('triage.csv').trim().split(/\r?\n/).slice(1);
    const labels = Object.fromEntries(rows.map((l) => [l.split(',')[0], l.split(',').at(-2)]));
    expect(labels).toEqual({ '41': 'bug', '42': 'feature', '43': 'question', '44': 'docs' });
  });
});

describe('Tier B templates — live mode without credentials fails truthfully', () => {
  it('B02 without a Discord credential fails with CREDENTIAL_REQUIRED (no fake success)', async () => {
    const r = await runTemplate(host, 'B02', { demo: false });
    expect(r.execution.state).toBe('failed');
    expect(r.execution.error?.code).toBe('CREDENTIAL_REQUIRED');
  });

  it('B04 without an SMTP credential is rejected before sending', async () => {
    const { workflowId } = await instantiate(host, 'B04', { demo: false });
    const res = await host.api<{ error: { code: string } }>('POST', `/api/workflows/${workflowId}/run`, {});
    if (res.status === 200) {
      const done = await host.ctx.executions.waitFor((res.body as unknown as { executionId: string }).executionId);
      expect(done.state).toBe('failed');
    } else {
      expect(res.status).toBe(422);
    }
  });

  it('live variables point at real provider endpoints, not fixtures', async () => {
    const { workflowId } = await instantiate(host, 'B01', { demo: false });
    const wf = await host.api<{ settings: { variables: Record<string, string> } }>('GET', `/api/workflows/${workflowId}`);
    expect(wf.body.settings.variables.apiBaseUrl).toBe('https://api.github.com');
  });
});
