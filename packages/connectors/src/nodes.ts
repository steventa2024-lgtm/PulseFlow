import type { Item, NodeManifest } from '@pulseflow/contracts';
import { NodeError, isRetryableStatus, parseRetryAfter, type HttpResponse, type NodeDefinition, type NodeExecutionContext } from '@pulseflow/engine';

function def(
  manifest: Omit<NodeManifest, 'version' | 'inputs' | 'outputs' | 'risk' | 'category'> & Partial<NodeManifest>,
  execute: NodeDefinition['execute'],
): NodeDefinition {
  return { manifest: { version: 1, inputs: [{ name: 'main' }], outputs: [{ name: 'main' }], risk: 'normal', category: 'connector', ...manifest }, execute };
}

function check(res: HttpResponse, provider: string): void {
  if (res.status < 400) return;
  let detail = res.text().slice(0, 300);
  try {
    const b = res.json() as { message?: string; description?: string };
    detail = b.message ?? b.description ?? detail;
  } catch {
    // non-JSON error body
  }
  throw new NodeError(`${provider.toUpperCase()}_HTTP_${res.status}`, `${provider} API returned ${res.status}: ${detail}`, {
    retryable: isRetryableStatus(res.status),
    retryAfterMs:
      parseRetryAfter(res.headers['retry-after']) ??
      (res.headers['x-ratelimit-reset'] && res.status === 403 ? Math.max(0, Number(res.headers['x-ratelimit-reset']) * 1000 - Date.now()) : undefined),
  });
}

async function optionalCredential(ctx: NodeExecutionContext, id: unknown) {
  return typeof id === 'string' && id ? ctx.services.getCredential(id) : undefined;
}

const GITHUB_API = 'https://api.github.com';

export const githubNode = def(
  {
    type: 'connector.github',
    displayName: 'GitHub',
    description:
      'List issues or releases from a repository via the official REST API. Public repos work without a token (60 requests/hour); a token raises limits and allows private repos.',
    icon: 'Github',
    permissions: ['network'],
    status: 'stable',
    parameters: [
      {
        name: 'operation',
        label: 'Operation',
        type: 'select',
        default: 'listReleases',
        noExpression: true,
        options: [
          { label: 'List releases', value: 'listReleases' },
          { label: 'List issues', value: 'listIssues' },
          { label: 'Get repository', value: 'getRepo' },
        ],
      },
      { name: 'owner', label: 'Owner', type: 'string', required: true, placeholder: 'electron' },
      { name: 'repo', label: 'Repository', type: 'string', required: true, placeholder: 'electron' },
      {
        name: 'state',
        label: 'Issue state',
        type: 'select',
        default: 'open',
        noExpression: true,
        options: ['open', 'closed', 'all'].map((v) => ({ label: v, value: v })),
        showIf: { param: 'operation', equals: ['listIssues'] },
      },
      { name: 'limit', label: 'Max results', type: 'number', default: 30, min: 1, max: 500, noExpression: true },
      { name: 'credential', label: 'Token (optional)', type: 'credential', credentialType: 'githubToken' },
      {
        name: 'apiBaseUrl',
        label: 'API base URL',
        type: 'string',
        default: GITHUB_API,
        description: 'Change only for GitHub Enterprise Server or the PulseFlow demo fixture.',
      },
    ],
  },
  async (ctx) => {
    const out: Item[] = [];
    const cred = await optionalCredential(ctx, ctx.param('credential'));
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(cred ? { authorization: `Bearer ${cred.data.token}` } : {}),
    };
    const base = String(ctx.param('apiBaseUrl') || GITHUB_API).replace(/\/+$/, '');
    const owner = encodeURIComponent(String(ctx.param('owner')));
    const repo = encodeURIComponent(String(ctx.param('repo')));
    const op = ctx.param<string>('operation');
    const limit = ctx.param<number>('limit');
    if (op === 'getRepo') {
      const res = await ctx.services.http.request({ method: 'GET', url: `${base}/repos/${owner}/${repo}`, headers, signal: ctx.signal });
      check(res, 'GitHub');
      return { main: [{ json: res.json() as Record<string, unknown> }] };
    }
    let url: string | null =
      op === 'listIssues'
        ? `${base}/repos/${owner}/${repo}/issues?state=${ctx.param('state')}&per_page=${Math.min(100, limit)}`
        : `${base}/repos/${owner}/${repo}/releases?per_page=${Math.min(100, limit)}`;
    while (url && out.length < limit) {
      const res = await ctx.services.http.request({ method: 'GET', url, headers, signal: ctx.signal });
      check(res, 'GitHub');
      ctx.log('info', `GitHub rate limit remaining: ${res.headers['x-ratelimit-remaining'] ?? 'unknown'}`);
      const list = res.json() as Record<string, unknown>[];
      for (const it of list) {
        if (out.length >= limit) break;
        if (op === 'listIssues' && it.pull_request) continue;
        out.push({ json: it });
      }
      const m = /<([^>]+)>\s*;\s*rel="next"/.exec(res.headers.link ?? '');
      url = m?.[1] ?? null;
    }
    return { main: out };
  },
);

export const discordNode = def(
  {
    type: 'connector.discordWebhook',
    displayName: 'Discord Webhook',
    description: 'Posts a message to a Discord channel through a webhook you created in channel settings.',
    icon: 'MessageSquare',
    permissions: ['network'],
    status: 'requires-setup',
    sideEffects: 'Posts publicly visible messages to a Discord channel.',
    parameters: [
      {
        name: 'credential',
        label: 'Webhook',
        type: 'credential',
        credentialType: 'discordWebhook',
        description: 'Leave empty only when using a demo URL below.',
      },
      {
        name: 'webhookUrlOverride',
        label: 'Demo/test webhook URL',
        type: 'string',
        default: '',
        description: 'Used when no credential is selected (e.g. the bundled demo fixture).',
      },
      { name: 'content', label: 'Message', type: 'text', required: true, default: '{{ $json.title }} — {{ $json.link }}' },
      { name: 'username', label: 'Display name', type: 'string', default: 'PulseFlow' },
    ],
  },
  async (ctx) => {
    const cred = await optionalCredential(ctx, ctx.param('credential'));
    const url = cred?.data.url ?? String(ctx.param('webhookUrlOverride') ?? '');
    if (!url) throw new NodeError('CREDENTIAL_REQUIRED', 'Select a Discord webhook credential');
    if (cred && !/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//.test(url)) throw new NodeError('INVALID_CREDENTIAL', 'Not a Discord webhook URL');
    const out: Item[] = [];
    for (let i = 0; i < ctx.items.length; i++) {
      const content = String(ctx.param('content', i) ?? '').slice(0, 2000);
      const res = await ctx.services.http.request({
        method: 'POST',
        url: `${url}${url.includes('?') ? '&' : '?'}wait=true`,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content, username: ctx.param('username', i), allowed_mentions: { parse: [] } }),
        signal: ctx.signal,
      });
      check(res, 'Discord');
      const body = res.text() ? (res.json() as { id?: string }) : {};
      out.push({ json: { ...ctx.items[i]!.json, discord: { messageId: body.id ?? null, status: res.status } } });
    }
    return { main: out };
  },
);

const TELEGRAM_API = 'https://api.telegram.org';

export const telegramNode = def(
  {
    type: 'connector.telegram',
    displayName: 'Telegram Bot',
    description: 'Sends a message from your bot to a chat via the Telegram Bot API.',
    icon: 'Send',
    permissions: ['network'],
    status: 'requires-setup',
    sideEffects: 'Sends Telegram messages.',
    parameters: [
      { name: 'credential', label: 'Bot', type: 'credential', credentialType: 'telegramBot' },
      { name: 'demoToken', label: 'Demo token (fixture only)', type: 'string', default: '' },
      { name: 'chatId', label: 'Chat ID', type: 'string', required: true },
      { name: 'text', label: 'Text', type: 'text', required: true },
      { name: 'apiBaseUrl', label: 'API base URL', type: 'string', default: TELEGRAM_API },
    ],
  },
  async (ctx) => {
    const cred = await optionalCredential(ctx, ctx.param('credential'));
    const token = cred?.data.token ?? String(ctx.param('demoToken') ?? '');
    if (!token) throw new NodeError('CREDENTIAL_REQUIRED', 'Select a Telegram bot credential');
    const base = String(ctx.param('apiBaseUrl') || TELEGRAM_API).replace(/\/+$/, '');
    const out: Item[] = [];
    for (let i = 0; i < ctx.items.length; i++) {
      const res = await ctx.services.http.request({
        method: 'POST',
        url: `${base}/bot${token}/sendMessage`,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: String(ctx.param('chatId', i)), text: String(ctx.param('text', i)).slice(0, 4096) }),
        signal: ctx.signal,
      });
      check(res, 'Telegram');
      const body = res.json() as { ok: boolean; result?: { message_id?: number }; description?: string };
      if (!body.ok) throw new NodeError('TELEGRAM_ERROR', body.description ?? 'Telegram returned ok=false');
      out.push({ json: { ...ctx.items[i]!.json, telegram: { messageId: body.result?.message_id ?? null } } });
    }
    return { main: out };
  },
);

export const connectorNodes = [githubNode, discordNode, telegramNode];
