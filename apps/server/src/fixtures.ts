import net from 'node:net';
import type { FastifyInstance } from 'fastify';

/**
 * Deterministic loopback stand-ins used by offline (Tier A) templates and the clearly labelled
 * "demo mode" of connected (Tier B) templates. They imitate response *shapes* of public APIs
 * using synthetic data only; nothing here talks to a real provider.
 */
export interface FixtureState {
  monitorStatus: number;
  flaky: Map<string, number>;
  discord: { id: string; content: string; username?: string; at: string }[];
  telegram: { chatId: string; text: string; at: string }[];
  sheets: Map<string, unknown[][]>;
  smtp: { from: string; to: string[]; data: string; at: string }[];
}

export function createFixtureState(): FixtureState {
  return { monitorStatus: 200, flaky: new Map(), discord: [], telegram: [], sheets: new Map(), smtp: [] };
}

const DEMO_NOTICE = 'PulseFlow demo fixture — synthetic data, not a real service';

function feedXml(variant: number, base: string): string {
  const entries = [
    { id: 'demo-1', title: 'Designing local-first automation', day: '01' },
    { id: 'demo-2', title: 'Why retries need jitter', day: '02' },
    { id: 'demo-3', title: 'Safe expression languages', day: '03' },
    { id: 'demo-4', title: 'Durable timers explained', day: '04' },
  ].slice(0, variant >= 2 ? 4 : 3);
  const items = entries
    .reverse()
    .map((e) => `<item><guid isPermaLink="false">${e.id}</guid><title>${e.title}</title><link>${base}/articles/${e.id}</link><pubDate>${new Date(`2026-01-${e.day}T08:00:00Z`).toUTCString()}</pubDate><description>Sample article ${e.id}</description></item>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>PulseFlow Demo Feed</title><link>${base}</link><description>${DEMO_NOTICE}</description>${items}</channel></rss>`;
}

const RELEASES = Array.from({ length: 12 }, (_, i) => {
  const n = 12 - i;
  return {
    id: 1000 + n,
    tag_name: `v1.${n}.0`,
    name: `Release 1.${n}.0`,
    draft: false,
    prerelease: n === 12,
    published_at: new Date(Date.UTC(2026, 0, n, 12)).toISOString(),
    html_url: `https://example.invalid/pulseflow-demo/sample/releases/v1.${n}.0`,
    body: `Synthetic release notes for 1.${n}.0`,
  };
});

const ISSUES = [
  { number: 41, title: 'App crashes when the folder is missing', body: 'Error stack trace attached, crash on start' },
  { number: 42, title: 'Add dark mode to settings page', body: 'Feature request: would be nice to have' },
  { number: 43, title: 'How do I schedule a workflow?', body: 'Question about cron syntax' },
  { number: 44, title: 'README typo in install section', body: 'Docs: "pnmp" should be "pnpm"' },
  { number: 45, title: 'Pull request: fix typo', body: '', pull_request: { url: 'x' } },
].map((i) => ({ ...i, id: 5000 + i.number, state: 'open', html_url: `https://example.invalid/pulseflow-demo/sample/issues/${i.number}`, created_at: '2026-01-05T10:00:00Z' }));

function page<T>(list: T[], query: Record<string, string | undefined>, url: string): { items: T[]; link?: string } {
  const per = Math.max(1, Math.min(100, Number(query.per_page ?? 30)));
  const p = Math.max(1, Number(query.page ?? 1));
  const items = list.slice((p - 1) * per, p * per);
  if (p * per >= list.length) return { items };
  const next = new URL(url);
  next.searchParams.set('page', String(p + 1));
  next.searchParams.set('per_page', String(per));
  return { items, link: `<${next.toString()}>; rel="next"` };
}

function between(prompt: string): string {
  const m = /--- TEXT START ---\n([\s\S]*)\n--- TEXT END ---/.exec(prompt);
  return (m?.[1] ?? prompt).trim();
}

const KEYWORDS: Record<string, string[]> = {
  bug: ['crash', 'error', 'bug', 'broken', 'fail'],
  feature: ['feature', 'add ', 'would be nice', 'support'],
  docs: ['docs', 'readme', 'typo', 'documentation'],
  question: ['how do', 'question', '?'],
};

function fakeOllama(prompt: string): string {
  const text = between(prompt);
  const labelsMatch = /exactly one of these labels: ([^.]+)\./.exec(prompt);
  if (labelsMatch) {
    const labels = labelsMatch[1]!.split(',').map((s) => s.trim());
    const lower = text.toLowerCase();
    for (const label of labels) if ((KEYWORDS[label] ?? [label]).some((k) => lower.includes(k))) return label;
    return labels[labels.length - 1] ?? '';
  }
  if (prompt.includes('Reply with JSON only')) return JSON.stringify({ demo: true, characters: text.length });
  const sentences = text
    .replace(/^#+\s.*$/gm, '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 2);
  return `[Demo fixture, not an AI model] ${sentences.join(' ') || text.slice(0, 160)}`;
}

export function registerFixtures(app: FastifyInstance, state: FixtureState, baseUrl: () => string): void {
  app.get('/demo', async () => ({ notice: DEMO_NOTICE, endpoints: ['monitor', 'feed.xml', 'api/health', 'api/slow', 'api/error', 'flaky', 'github', 'discord', 'telegram', 'sheets', 'ollama', 'smtp'] }));

  app.get('/demo/monitor', async (_req, reply) => {
    reply.code(state.monitorStatus).type('text/html');
    return `<!doctype html><title>Demo site</title><p>${DEMO_NOTICE}. Status ${state.monitorStatus}.</p>`;
  });
  app.post<{ Querystring: { status?: string } }>('/demo/monitor/state', async (req) => {
    const s = Number(req.query.status ?? 200);
    if (!Number.isInteger(s) || s < 200 || s > 599) return { ok: false };
    state.monitorStatus = s;
    return { ok: true, status: s };
  });

  app.get<{ Querystring: { variant?: string } }>('/demo/feed.xml', async (req, reply) => {
    reply.type('application/rss+xml; charset=utf-8');
    return feedXml(Number(req.query.variant ?? 1), baseUrl());
  });

  app.get('/demo/api/health', async () => ({ status: 'ok', notice: DEMO_NOTICE }));
  app.get('/demo/api/slow', async () => {
    await new Promise((r) => setTimeout(r, 3000));
    return { status: 'ok', slow: true };
  });
  app.get('/demo/api/error', async (_req, reply) => reply.code(500).send({ status: 'error', message: 'Synthetic failure' }));

  app.get<{ Querystring: { failures?: string; key?: string } }>('/demo/flaky', async (req, reply) => {
    const key = String(req.query.key ?? 'default').slice(0, 100);
    const failures = Math.max(0, Math.min(10, Number(req.query.failures ?? 2)));
    const call = (state.flaky.get(key) ?? 0) + 1;
    state.flaky.set(key, call);
    if (state.flaky.size > 10_000) state.flaky.clear();
    if (call <= failures) return reply.code(503).header('retry-after', '0').send({ ok: false, call, message: `Synthetic outage (call ${call} of ${failures} failing)` });
    return { ok: true, call };
  });

  app.get<{ Params: { owner: string; repo: string }; Querystring: Record<string, string> }>('/demo/github/repos/:owner/:repo/releases', async (req, reply) => {
    const { items, link } = page(RELEASES, req.query, `${baseUrl()}/github${req.url.slice('/demo/github'.length)}`);
    reply.header('x-ratelimit-remaining', '59');
    if (link) reply.header('link', link);
    return items;
  });
  app.get<{ Params: { owner: string; repo: string }; Querystring: Record<string, string> }>('/demo/github/repos/:owner/:repo/issues', async (req, reply) => {
    const { items, link } = page(ISSUES, req.query, `${baseUrl()}/github${req.url.slice('/demo/github'.length)}`);
    reply.header('x-ratelimit-remaining', '59');
    if (link) reply.header('link', link);
    return items;
  });
  app.get<{ Params: { owner: string; repo: string } }>('/demo/github/repos/:owner/:repo', async (req) => ({ full_name: `${req.params.owner}/${req.params.repo}`, description: DEMO_NOTICE, stargazers_count: 42, open_issues_count: ISSUES.length }));

  app.post<{ Body: { content?: string; username?: string } }>('/demo/discord/webhook', async (req, reply) => {
    const content = String(req.body?.content ?? '');
    if (!content) return reply.code(400).send({ message: 'Cannot send an empty message', code: 50006 });
    const msg = { id: String(900000 + state.discord.length + 1), content, username: req.body?.username, at: new Date().toISOString() };
    state.discord.push(msg);
    return msg;
  });
  app.get('/demo/discord/messages', async () => state.discord);

  app.post<{ Params: { bot: string }; Body: { chat_id?: string; text?: string } }>('/demo/telegram/:bot/sendMessage', async (req, reply) => {
    if (req.params.bot !== 'botdemo-token') return reply.code(401).send({ ok: false, error_code: 401, description: 'Unauthorized' });
    if (!req.body?.chat_id || !req.body.text) return reply.code(400).send({ ok: false, error_code: 400, description: 'Bad Request: chat_id and text are required' });
    state.telegram.push({ chatId: String(req.body.chat_id), text: String(req.body.text), at: new Date().toISOString() });
    return { ok: true, result: { message_id: state.telegram.length, chat: { id: Number(req.body.chat_id) || 0 }, text: req.body.text } };
  });
  app.get('/demo/telegram/messages', async () => state.telegram);

  app.post<{ Params: { id: string; '*': string }; Querystring: { valueInputOption?: string }; Body: { values?: unknown[][] } }>('/demo/sheets/v4/spreadsheets/:id/values/*', async (req, reply) => {
    const rangeAction = decodeURIComponent(req.params['*']);
    if (!rangeAction.endsWith(':append')) return reply.code(404).send({ error: { code: 404, message: 'Unknown method' } });
    if (req.query.valueInputOption !== 'RAW' && req.query.valueInputOption !== 'USER_ENTERED') return reply.code(400).send({ error: { code: 400, message: 'valueInputOption is required' } });
    const values = req.body?.values;
    if (!Array.isArray(values) || !values.every(Array.isArray)) return reply.code(400).send({ error: { code: 400, message: 'values must be a 2D array' } });
    const rows = state.sheets.get(req.params.id) ?? [];
    rows.push(...values);
    state.sheets.set(req.params.id, rows);
    const sheet = rangeAction.split('!')[0];
    return { spreadsheetId: req.params.id, tableRange: `${sheet}!A1:D${rows.length - values.length}`, updates: { spreadsheetId: req.params.id, updatedRange: `${sheet}!A${rows.length - values.length + 1}:D${rows.length}`, updatedRows: values.length, updatedCells: values.flat().length } };
  });
  app.get<{ Params: { id: string } }>('/demo/sheets/rows/:id', async (req) => state.sheets.get(req.params.id) ?? []);

  app.post<{ Body: { model?: string; prompt?: string } }>('/demo/ollama/api/generate', async (req, reply) => {
    if (!req.body?.prompt) return reply.code(400).send({ error: 'prompt is required' });
    return { model: req.body.model ?? 'demo-fixture', response: fakeOllama(req.body.prompt), done: true, eval_count: 0 };
  });
  app.get('/demo/ollama/api/tags', async () => ({ models: [{ name: 'demo-fixture', details: { notice: DEMO_NOTICE } }] }));

  app.get('/demo/smtp/messages', async () => state.smtp);
}

/**
 * Minimal loopback SMTP sink for the B04 demo. It accepts messages and records them in memory;
 * it never relays mail anywhere.
 */
export function startSmtpSink(state: FixtureState): Promise<{ port: number; close: () => Promise<void> }> {
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    socket.setTimeout(30_000, () => socket.destroy());
    let buffer = '';
    let inData = false;
    let data = '';
    let from = '';
    let to: string[] = [];
    const send = (line: string) => socket.write(`${line}\r\n`);
    send('220 pulseflow-demo-smtp ESMTP sink (messages are stored locally, never delivered)');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 5 * 1024 * 1024) return socket.destroy();
      let idx: number;
      while ((idx = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            state.smtp.push({ from, to, data, at: new Date().toISOString() });
            if (state.smtp.length > 500) state.smtp.shift();
            send(`250 OK queued as demo-${state.smtp.length}`);
          } else data += `${line.startsWith('..') ? line.slice(1) : line}\n`;
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO') {
          send('250-pulseflow-demo-smtp');
          send('250 8BITMIME');
        } else if (cmd === 'HELO') send('250 pulseflow-demo-smtp');
        else if (cmd === 'MAIL') {
          from = /<([^>]*)>/.exec(line)?.[1] ?? '';
          to = [];
          send('250 OK');
        } else if (cmd === 'RCPT') {
          to.push(/<([^>]*)>/.exec(line)?.[1] ?? '');
          send('250 OK');
        } else if (cmd === 'DATA') {
          inData = true;
          data = '';
          send('354 End data with <CR><LF>.<CR><LF>');
        } else if (cmd === 'RSET') {
          from = '';
          to = [];
          send('250 OK');
        } else if (cmd === 'NOOP') send('250 OK');
        else if (cmd === 'QUIT') {
          send('221 Bye');
          socket.end();
        } else send('502 Command not implemented');
      }
    });
    socket.on('error', () => undefined);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      resolve({ port: addr.port, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}
