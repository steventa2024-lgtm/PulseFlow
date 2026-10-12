import type { Item } from '@pulseflow/contracts';
import { isRetryableStatus, NodeError, parseRetryAfter, type HttpResponse, type NodeExecutionContext } from '@pulseflow/engine';
import { defineNode, getPath, requireString } from './helpers';
import { parseFeed } from './feed';

export async function authHeaders(ctx: NodeExecutionContext, credentialId: unknown): Promise<Record<string, string>> {
  if (typeof credentialId !== 'string' || !credentialId) return {};
  const cred = await ctx.services.getCredential(credentialId);
  switch (cred.type) {
    case 'httpBasic':
      return { authorization: `Basic ${Buffer.from(`${cred.data.username ?? ''}:${cred.data.password ?? ''}`).toString('base64')}` };
    case 'httpBearer':
    case 'githubToken':
      return { authorization: `Bearer ${cred.data.token ?? ''}` };
    case 'httpHeader':
      if (!cred.data.name || /[\r\n]/.test(cred.data.name)) throw new NodeError('INVALID_CREDENTIAL', 'Header credential has an invalid name');
      return { [cred.data.name.toLowerCase()]: cred.data.value ?? '' };
    default:
      throw new NodeError('INVALID_CREDENTIAL', `Credential type "${cred.type}" cannot be used for HTTP authentication`);
  }
}

export function kvListToRecord(list: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(list)) return out;
  for (const entry of list as { name?: unknown; value?: unknown }[]) {
    if (!entry || typeof entry.name !== 'string' || !entry.name.trim()) continue;
    const name = entry.name.trim();
    if (/[\r\n]/.test(name) || /[\r\n]/.test(String(entry.value ?? '')))
      throw new NodeError('INVALID_HEADER', `Header/parameter "${name}" contains a line break`);
    out[name] = entry.value === undefined || entry.value === null ? '' : typeof entry.value === 'object' ? JSON.stringify(entry.value) : String(entry.value);
  }
  return out;
}

export function throwForStatus(res: HttpResponse, now = Date.now()): void {
  if (res.status < 400) return;
  const snippet = res.text().slice(0, 300);
  throw new NodeError(`HTTP_${res.status}`, `HTTP ${res.status} ${res.statusText} from ${new URL(res.url).host}${snippet ? `: ${snippet}` : ''}`, {
    retryable: isRetryableStatus(res.status),
    retryAfterMs: parseRetryAfter(res.headers['retry-after'], now),
    details: { status: res.status },
  });
}

function parseBody(res: HttpResponse, format: string): unknown {
  const ct = res.headers['content-type'] ?? '';
  if (format === 'text') return res.text();
  if (format === 'json' || (format === 'auto' && /json/i.test(ct))) {
    const t = res.text();
    if (!t) return null;
    try {
      return JSON.parse(t, (k, v: unknown) => (k === '__proto__' || k === 'constructor' ? undefined : v));
    } catch {
      if (format === 'json') throw new NodeError('INVALID_JSON_RESPONSE', `Response from ${res.url} is not valid JSON`);
      return t;
    }
  }
  return res.text();
}

export const httpRequestNode = defineNode(
  {
    type: 'core.httpRequest',
    displayName: 'HTTP Request',
    description: 'Calls any HTTP API: all methods, headers, query, JSON/form/text bodies, auth, pagination, timeouts.',
    category: 'network',
    icon: 'Globe',
    permissions: ['network'],
    errorOutput: true,
    parameters: [
      {
        name: 'method',
        label: 'Method',
        type: 'select',
        default: 'GET',
        noExpression: true,
        options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((m) => ({ label: m, value: m })),
      },
      { name: 'url', label: 'URL', type: 'string', required: true, placeholder: 'https://api.example.com/items' },
      { name: 'query', label: 'Query parameters', type: 'keyvalue', default: [] },
      { name: 'headers', label: 'Headers', type: 'keyvalue', default: [] },
      {
        name: 'bodyMode',
        label: 'Body',
        type: 'select',
        default: 'none',
        noExpression: true,
        options: [
          { label: 'None', value: 'none' },
          { label: 'JSON', value: 'json' },
          { label: 'Form (urlencoded)', value: 'form' },
          { label: 'Raw text', value: 'text' },
        ],
      },
      { name: 'body', label: 'Body content', type: 'text', default: '{{ $json }}', showIf: { param: 'bodyMode', equals: ['json', 'text'] } },
      { name: 'formFields', label: 'Form fields', type: 'keyvalue', default: [], showIf: { param: 'bodyMode', equals: ['form'] } },
      {
        name: 'credential',
        label: 'Authentication',
        type: 'credential',
        credentialType: 'httpBasic,httpBearer,httpHeader,githubToken',
        description: 'Optional. Credentials are never stored in workflow files or logs.',
      },
      {
        name: 'responseFormat',
        label: 'Response format',
        type: 'select',
        default: 'auto',
        noExpression: true,
        options: [
          { label: 'Auto-detect', value: 'auto' },
          { label: 'JSON', value: 'json' },
          { label: 'Text', value: 'text' },
        ],
      },
      {
        name: 'failOnError',
        label: 'Fail on HTTP 4xx/5xx',
        type: 'boolean',
        default: true,
        noExpression: true,
        description:
          'When off, error statuses are returned as items, and timeouts/connection errors become items with status 0 (retried per item using the node retry policy).',
      },
      { name: 'timeoutMs', label: 'Timeout (ms)', type: 'number', default: 30_000, min: 100, max: 600_000, noExpression: true },
      { name: 'followRedirects', label: 'Follow redirects', type: 'boolean', default: true, noExpression: true },
      { name: 'maxResponseMb', label: 'Max response size (MB)', type: 'number', default: 10, min: 1, max: 500, noExpression: true },
      {
        name: 'pagination',
        label: 'Pagination',
        type: 'select',
        default: 'none',
        noExpression: true,
        options: [
          { label: 'None', value: 'none' },
          { label: 'Next URL in response body', value: 'nextUrl' },
          { label: 'Page number query parameter', value: 'page' },
          { label: 'Link header (rel="next")', value: 'linkHeader' },
        ],
      },
      {
        name: 'nextUrlField',
        label: 'Next URL field',
        type: 'string',
        default: 'next',
        noExpression: true,
        showIf: { param: 'pagination', equals: ['nextUrl'] },
      },
      { name: 'pageParam', label: 'Page parameter', type: 'string', default: 'page', noExpression: true, showIf: { param: 'pagination', equals: ['page'] } },
      {
        name: 'maxPages',
        label: 'Max pages',
        type: 'number',
        default: 10,
        min: 1,
        max: 1000,
        noExpression: true,
        showIf: { param: 'pagination', equals: ['nextUrl', 'page', 'linkHeader'] },
      },
      {
        name: 'splitPath',
        label: 'Split list at path into items (optional)',
        type: 'string',
        default: '',
        noExpression: true,
        description: 'e.g. "data" or "." for a top-level list',
      },
    ],
  },
  async (ctx) => {
    const out: Item[] = [];
    for (let i = 0; i < ctx.items.length; i++) {
      const method = ctx.param<string>('method');
      const baseUrl = requireString(ctx.param('url', i), 'URL');
      const query = kvListToRecord(ctx.param('query', i));
      const headers = { ...kvListToRecord(ctx.param('headers', i)), ...(await authHeaders(ctx, ctx.param('credential', i))) };
      let body: string | undefined;
      const bodyMode = ctx.param<string>('bodyMode');
      if (bodyMode === 'json') {
        const v = ctx.param('body', i);
        body = typeof v === 'string' ? v : JSON.stringify(v);
        headers['content-type'] ??= 'application/json';
      } else if (bodyMode === 'text') {
        body = String(ctx.param('body', i) ?? '');
        headers['content-type'] ??= 'text/plain; charset=utf-8';
      } else if (bodyMode === 'form') {
        body = new URLSearchParams(kvListToRecord(ctx.param('formFields', i))).toString();
        headers['content-type'] ??= 'application/x-www-form-urlencoded';
      }
      const pagination = ctx.param<string>('pagination');
      const maxPages = pagination === 'none' ? 1 : ctx.param<number>('maxPages');
      let url: string | null = baseUrl;
      let page = Number(query[ctx.param<string>('pageParam') || 'page'] ?? 1) || 1;
      for (let p = 0; p < maxPages && url; p++) {
        const u: URL = new URL(url);
        if (p === 0 || pagination === 'page') for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
        if (pagination === 'page') u.searchParams.set(ctx.param<string>('pageParam') || 'page', String(page));
        const send = (): Promise<HttpResponse> =>
          ctx.services.http.request({
            method,
            url: u.toString(),
            headers,
            body,
            timeoutMs: ctx.param<number>('timeoutMs'),
            followRedirects: ctx.param<boolean>('followRedirects'),
            maxResponseBytes: ctx.param<number>('maxResponseMb') * 1024 * 1024,
            signal: ctx.signal,
          });
        const failOnError = ctx.param<boolean>('failOnError');
        let res: HttpResponse;
        if (failOnError) {
          res = await send();
          throwForStatus(res, ctx.clock.now().getTime());
        } else {
          // Report-style use: a transport failure for one item becomes a status-0 item instead of failing every item.
          const attempt = await sendWithItemRetries(ctx, send);
          if ('error' in attempt) {
            ctx.log('warn', `${method} ${u.host}${u.pathname} failed: ${attempt.error.message}`);
            out.push({ json: { status: 0, statusText: '', headers: {}, body: null, url: u.toString(), durationMs: null, error: attempt.error } });
            break;
          }
          res = attempt.res;
        }
        const parsed = parseBody(res, ctx.param<string>('responseFormat'));
        ctx.log('info', `${method} ${u.host}${u.pathname} → ${res.status} (${res.durationMs} ms)`);
        const splitPath = ctx.param<string>('splitPath');
        const list = splitPath ? (splitPath === '.' ? parsed : getPath(parsed, splitPath)) : undefined;
        if (splitPath && Array.isArray(list)) {
          for (const el of list) out.push({ json: el && typeof el === 'object' && !Array.isArray(el) ? (el as Record<string, unknown>) : { value: el } });
        } else {
          out.push({ json: { status: res.status, statusText: res.statusText, headers: res.headers, body: parsed, url: res.url, durationMs: res.durationMs } });
        }
        if (pagination === 'nextUrl') {
          const next = getPath(parsed, ctx.param<string>('nextUrlField'));
          url = typeof next === 'string' && next ? new URL(next, res.url).toString() : null;
        } else if (pagination === 'linkHeader') {
          const m = /<([^>]+)>\s*;\s*rel="?next"?/i.exec(res.headers.link ?? '');
          url = m?.[1] ? new URL(m[1], res.url).toString() : null;
        } else if (pagination === 'page') {
          page++;
          if (Array.isArray(list) && list.length === 0) url = null;
          if (!splitPath && (parsed === null || (Array.isArray(parsed) && parsed.length === 0))) url = null;
        } else {
          url = null;
        }
      }
    }
    return { main: out };
  },
);

const TRANSPORT_ERRORS = new Set(['HTTP_TIMEOUT', 'HTTP_NETWORK_ERROR', 'DNS_FAILED']);

async function sendWithItemRetries<T>(ctx: NodeExecutionContext, send: () => Promise<T>): Promise<{ res: T } | { error: { code: string; message: string } }> {
  const policy = ctx.node.retry;
  const attempts = Math.max(1, policy?.maxAttempts ?? 1);
  let delay = policy?.initialDelayMs ?? 1000;
  for (let n = 1; ; n++) {
    try {
      return { res: await send() };
    } catch (e) {
      if (!(e instanceof NodeError) || !TRANSPORT_ERRORS.has(e.code)) throw e;
      if (n >= attempts) return { error: { code: e.code, message: e.message } };
      ctx.log('warn', `Attempt ${n} failed (${e.message}); retrying in ${delay} ms`);
      await ctx.clock.sleep(delay, ctx.signal);
      delay = Math.min(policy?.maxDelayMs ?? 30_000, delay * (policy?.multiplier ?? 2));
    }
  }
}

export const webhookResponseNode = defineNode(
  {
    type: 'core.webhookResponse',
    displayName: 'Webhook Response',
    description: 'Sets the HTTP response for a Local Webhook trigger in "Using a Webhook Response node" mode.',
    category: 'network',
    icon: 'Reply',
    parameters: [
      { name: 'status', label: 'Status code', type: 'number', default: 200, min: 100, max: 599 },
      { name: 'body', label: 'Body', type: 'text', default: '{{ { "ok": true } }}' },
      { name: 'headers', label: 'Headers', type: 'keyvalue', default: [] },
    ],
  },
  async (ctx) => {
    const status = Number(ctx.param('status'));
    if (!Number.isInteger(status) || status < 100 || status > 599) throw new NodeError('INVALID_STATUS', `Invalid status ${status}`);
    const response = { status, body: ctx.param('body'), headers: kvListToRecord(ctx.param('headers')) };
    return { main: ctx.items.map((it, idx) => ({ json: { ...it.json, ...(idx === 0 ? { webhookResponse: response } : {}) } })) };
  },
);

export const graphqlNode = defineNode(
  {
    type: 'core.graphql',
    displayName: 'GraphQL Request',
    description: 'Sends a GraphQL query or mutation over HTTP POST.',
    category: 'network',
    icon: 'Share2',
    permissions: ['network'],
    parameters: [
      { name: 'url', label: 'Endpoint', type: 'string', required: true },
      { name: 'query', label: 'Query', type: 'code', required: true, noExpression: true, default: 'query { __typename }' },
      { name: 'variables', label: 'Variables (JSON)', type: 'text', default: '{{ {} }}' },
      { name: 'credential', label: 'Authentication', type: 'credential', credentialType: 'httpBasic,httpBearer,httpHeader,githubToken' },
      { name: 'timeoutMs', label: 'Timeout (ms)', type: 'number', default: 30_000, noExpression: true },
    ],
  },
  async (ctx) => {
    const out: Item[] = [];
    for (let i = 0; i < ctx.items.length; i++) {
      const vars = ctx.param('variables', i);
      const variables = typeof vars === 'string' ? (vars.trim() ? (JSON.parse(vars) as unknown) : {}) : vars;
      const res = await ctx.services.http.request({
        method: 'POST',
        url: requireString(ctx.param('url', i), 'Endpoint'),
        headers: { 'content-type': 'application/json', accept: 'application/json', ...(await authHeaders(ctx, ctx.param('credential', i))) },
        body: JSON.stringify({ query: ctx.param('query'), variables }),
        timeoutMs: ctx.param<number>('timeoutMs'),
        signal: ctx.signal,
      });
      throwForStatus(res, ctx.clock.now().getTime());
      const body = res.json() as { data?: unknown; errors?: { message: string }[] };
      if (body.errors?.length) throw new NodeError('GRAPHQL_ERROR', body.errors.map((e) => e.message).join('; '));
      out.push({ json: { data: body.data ?? null } });
    }
    return { main: out };
  },
);

export const rssReadNode = defineNode(
  {
    type: 'core.rssRead',
    displayName: 'RSS Read',
    description: 'Fetches an RSS or Atom feed and outputs one item per entry.',
    category: 'network',
    icon: 'Rss',
    permissions: ['network'],
    parameters: [
      { name: 'url', label: 'Feed URL', type: 'string', required: true },
      { name: 'limit', label: 'Max entries', type: 'number', default: 50, min: 1, max: 1000, noExpression: true },
    ],
  },
  async (ctx) => {
    const out: Item[] = [];
    const urls = new Set(ctx.items.map((_, i) => requireString(ctx.param('url', i), 'Feed URL')));
    for (const url of urls) {
      const res = await ctx.services.http.request({ method: 'GET', url, timeoutMs: 20_000, maxResponseBytes: 5 * 1024 * 1024, signal: ctx.signal });
      throwForStatus(res, ctx.clock.now().getTime());
      for (const e of parseFeed(res.text()).slice(0, ctx.param<number>('limit'))) out.push({ json: { ...e, feedUrl: url } });
    }
    return { main: out };
  },
);

export const httpDownloadNode = defineNode(
  {
    type: 'core.httpDownload',
    displayName: 'HTTP Download',
    description: 'Downloads a URL to a file in a granted folder with a size limit.',
    category: 'network',
    icon: 'Download',
    permissions: ['network', 'fs.write'],
    sideEffects: 'Writes downloaded files to disk.',
    parameters: [
      { name: 'url', label: 'URL', type: 'string', required: true },
      { name: 'path', label: 'Save as', type: 'path', required: true },
      { name: 'maxMb', label: 'Max size (MB)', type: 'number', default: 50, min: 1, max: 2048, noExpression: true },
      { name: 'overwrite', label: 'Overwrite existing file', type: 'boolean', default: false, noExpression: true },
    ],
  },
  async (ctx) => {
    const out: Item[] = [];
    for (let i = 0; i < ctx.items.length; i++) {
      const url = requireString(ctx.param('url', i), 'URL');
      const dest = requireString(ctx.param('path', i), 'Save as');
      ctx.services.fs.resolveWrite(dest);
      const res = await ctx.services.http.request({
        method: 'GET',
        url,
        timeoutMs: 120_000,
        maxResponseBytes: ctx.param<number>('maxMb') * 1024 * 1024,
        signal: ctx.signal,
      });
      throwForStatus(res, ctx.clock.now().getTime());
      const written = await ctx.services.fs.writeBytes(dest, res.body, { overwrite: ctx.param<boolean>('overwrite') });
      out.push({ json: { ...ctx.items[i]!.json, url, file: written, contentType: res.headers['content-type'] ?? null } });
    }
    return { main: out };
  },
);

export const emailSendNode = defineNode(
  {
    type: 'core.emailSend',
    displayName: 'Send Email (SMTP)',
    description: 'Sends email through your own SMTP server credential. Requires the "email" permission.',
    category: 'notify',
    icon: 'Mail',
    permissions: ['email', 'network'],
    risk: 'sensitive',
    status: 'requires-setup',
    sideEffects: 'Sends real email to external recipients.',
    parameters: [
      { name: 'credential', label: 'SMTP account', type: 'credential', credentialType: 'smtp', required: true },
      { name: 'from', label: 'From', type: 'string', required: true },
      { name: 'to', label: 'To (comma separated)', type: 'string', required: true },
      { name: 'subject', label: 'Subject', type: 'string', required: true },
      { name: 'text', label: 'Text body', type: 'text', required: true },
      { name: 'html', label: 'HTML body (optional)', type: 'text' },
    ],
  },
  async (ctx) => {
    if (!ctx.settings.permissions.email) throw new NodeError('PERMISSION_DENIED', 'Sending email is not permitted for this workflow (Permissions → Email)');
    if (!ctx.services.sendEmail) throw new NodeError('NOT_AVAILABLE', 'Email sending is not available in this host');
    const out: Item[] = [];
    for (let i = 0; i < ctx.items.length; i++) {
      const to = String(ctx.param('to', i) ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (to.length === 0 || to.length > 50) throw new NodeError('INVALID_RECIPIENTS', 'Provide between 1 and 50 recipients');
      const html = ctx.param('html', i);
      const info = await ctx.services.sendEmail({
        credentialId: String(ctx.param('credential', i)),
        from: String(ctx.param('from', i)),
        to,
        subject: String(ctx.param('subject', i)).slice(0, 998),
        text: String(ctx.param('text', i)),
        ...(html ? { html: String(html) } : {}),
      });
      out.push({ json: { ...ctx.items[i]!.json, email: info } });
    }
    return { main: out };
  },
);

export const networkNodes = [httpRequestNode, webhookResponseNode, graphqlNode, rssReadNode, httpDownloadNode, emailSendNode];
