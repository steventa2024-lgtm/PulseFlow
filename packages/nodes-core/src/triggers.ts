import { NodeError, validateCron } from '@pulseflow/engine';
import { defineNode } from './helpers';
import { parseFeed } from './feed';

const passThrough = (ctx: { items: { json: Record<string, unknown> }[] }) => ctx.items;

export const manualTrigger = defineNode(
  {
    type: 'core.manualTrigger',
    displayName: 'Manual Trigger',
    description: 'Starts the workflow when you press Run / Test, or via the API and CLI.',
    category: 'trigger',
    icon: 'Play',
    trigger: 'manual',
    parameters: [
      {
        name: 'sampleData',
        label: 'Default input (JSON)',
        type: 'json',
        default: {},
        noExpression: true,
        description: 'Used when the run request does not provide a payload.',
      },
    ],
  },
  async (ctx) => {
    if (ctx.items.length) return { main: ctx.items };
    const sample = ctx.rawParam('sampleData');
    const json = sample && typeof sample === 'object' && !Array.isArray(sample) ? (sample as Record<string, unknown>) : {};
    return { main: [{ json: { ...json } }] };
  },
);

export const scheduleTrigger = defineNode(
  {
    type: 'core.scheduleTrigger',
    displayName: 'Schedule',
    description: 'Runs on a cron schedule or fixed interval in the workflow timezone (DST-aware).',
    category: 'trigger',
    icon: 'Clock',
    trigger: 'schedule',
    parameters: [
      {
        name: 'mode',
        label: 'Mode',
        type: 'select',
        default: 'interval',
        noExpression: true,
        options: [
          { label: 'Every N seconds/minutes', value: 'interval' },
          { label: 'Cron expression', value: 'cron' },
        ],
      },
      { name: 'intervalSeconds', label: 'Interval (seconds)', type: 'number', default: 300, min: 1, max: 31_536_000, noExpression: true, showIf: { param: 'mode', equals: ['interval'] } },
      {
        name: 'cron',
        label: 'Cron expression',
        type: 'string',
        default: '0 9 * * *',
        placeholder: 'min hour day month weekday',
        noExpression: true,
        showIf: { param: 'mode', equals: ['cron'] },
        description: '5 fields (minute hour day month weekday) or 6 with seconds first.',
      },
      {
        name: 'missedRunPolicy',
        label: 'If runs were missed while closed',
        type: 'select',
        default: 'skip',
        noExpression: true,
        options: [
          { label: 'Skip them', value: 'skip' },
          { label: 'Run once on startup', value: 'runOnce' },
        ],
      },
    ],
  },
  async (ctx) => {
    if (ctx.items.length) return { main: ctx.items };
    return { main: [{ json: { firedAt: ctx.clock.now().toISOString(), scheduledFor: null, manual: true } }] };
  },
  {
    validate(node) {
      if ((node.parameters.mode ?? 'interval') !== 'cron') return [];
      const err = validateCron(String(node.parameters.cron ?? ''), 'UTC');
      return err ? [{ severity: 'error', code: 'INVALID_CRON', message: `${node.name}: ${err}`, nodeId: node.id, param: 'cron' }] : [];
    },
  },
);

export const webhookTrigger = defineNode(
  {
    type: 'core.webhookTrigger',
    displayName: 'Local Webhook',
    description: 'Receives HTTP requests on the local PulseFlow server (127.0.0.1 by default).',
    category: 'trigger',
    icon: 'Webhook',
    trigger: 'webhook',
    parameters: [
      {
        name: 'method',
        label: 'HTTP method',
        type: 'select',
        default: 'POST',
        noExpression: true,
        options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => ({ label: m, value: m })),
      },
      {
        name: 'responseMode',
        label: 'Respond',
        type: 'select',
        default: 'onReceived',
        noExpression: true,
        options: [
          { label: 'Immediately (202 Accepted, run queued)', value: 'onReceived' },
          { label: 'When the workflow finishes (last node output)', value: 'lastNode' },
          { label: 'Using a "Webhook Response" node', value: 'responseNode' },
        ],
      },
      {
        name: 'auth',
        label: 'Authentication',
        type: 'select',
        default: 'none',
        noExpression: true,
        options: [
          { label: 'Secret URL only', value: 'none' },
          { label: 'Shared secret header', value: 'header' },
          { label: 'HMAC-SHA256 signature', value: 'hmac' },
        ],
      },
      { name: 'secretCredential', label: 'Secret', type: 'credential', credentialType: 'webhookSecret', showIf: { param: 'auth', equals: ['header', 'hmac'] }, required: true },
      { name: 'headerName', label: 'Header name', type: 'string', default: 'x-pulseflow-signature', noExpression: true, showIf: { param: 'auth', equals: ['header', 'hmac'] } },
      { name: 'maxBodyKb', label: 'Max body size (KB)', type: 'number', default: 1024, min: 1, max: 20_480, noExpression: true },
    ],
    sideEffects: 'Opens an HTTP endpoint on the local PulseFlow server while the workflow is active.',
  },
  async (ctx) => {
    if (ctx.items.length) return { main: ctx.items };
    return { main: [{ json: { method: 'POST', headers: {}, query: {}, body: {}, receivedAt: ctx.clock.now().toISOString(), manual: true } }] };
  },
);

export const fileWatchTrigger = defineNode(
  {
    type: 'core.fileWatchTrigger',
    displayName: 'File Changed',
    description: 'Fires when a file changes. For append-only logs, emits only the newly added text.',
    category: 'trigger',
    icon: 'FileClock',
    trigger: 'fileWatch',
    permissions: ['fs.read'],
    parameters: [
      { name: 'path', label: 'File', type: 'path', required: true, description: 'Absolute path inside a granted folder.' },
      { name: 'pollSeconds', label: 'Check every (seconds)', type: 'number', default: 2, min: 1, max: 3600, noExpression: true },
      {
        name: 'emit',
        label: 'Emit',
        type: 'select',
        default: 'appended',
        noExpression: true,
        options: [
          { label: 'Newly appended text (logs)', value: 'appended' },
          { label: 'Change event only', value: 'event' },
        ],
      },
    ],
  },
  async (ctx) => {
    if (ctx.items.length) return { main: ctx.items };
    const p = ctx.param<string>('path');
    const st = await ctx.services.fs.stat(p);
    const text = ctx.param<string>('emit') === 'appended' ? await ctx.services.fs.readText(p, 5 * 1024 * 1024) : undefined;
    return { main: [{ json: { path: st.path, event: 'manual', size: st.size, modifiedAt: st.modifiedAt, ...(text !== undefined ? { appendedText: text } : {}) } }] };
  },
);

export const folderWatchTrigger = defineNode(
  {
    type: 'core.folderWatchTrigger',
    displayName: 'Folder Changed',
    description: 'Fires when files are added, changed, or removed in a folder (polling; reliable on all platforms).',
    category: 'trigger',
    icon: 'FolderSync',
    trigger: 'folderWatch',
    permissions: ['fs.read'],
    parameters: [
      { name: 'folder', label: 'Folder', type: 'path', required: true },
      { name: 'recursive', label: 'Include sub-folders', type: 'boolean', default: false, noExpression: true },
      { name: 'events', label: 'Events', type: 'stringList', default: ['created'], noExpression: true, description: 'Any of: created, modified, deleted' },
      { name: 'pollSeconds', label: 'Check every (seconds)', type: 'number', default: 2, min: 1, max: 3600, noExpression: true },
      { name: 'settleSeconds', label: 'Wait until unchanged for (seconds)', type: 'number', default: 1, min: 0, max: 600, noExpression: true, description: 'Avoids picking up files that are still being written.' },
    ],
  },
  async (ctx) => {
    if (ctx.items.length) return { main: ctx.items };
    // Manual test: treat every current file as "created".
    const files = await ctx.services.fs.list(ctx.param<string>('folder'), { recursive: ctx.param<boolean>('recursive') });
    return { main: files.map((f) => ({ json: { event: 'created', ...f } })) };
  },
);

export const pollTrigger = defineNode(
  {
    type: 'core.httpPollTrigger',
    displayName: 'HTTP Poll',
    description: 'Fetches a URL on an interval and fires when the response changes (or every time).',
    category: 'trigger',
    icon: 'RefreshCw',
    trigger: 'poll',
    permissions: ['network'],
    parameters: [
      { name: 'url', label: 'URL', type: 'string', required: true },
      { name: 'intervalSeconds', label: 'Interval (seconds)', type: 'number', default: 300, min: 5, max: 86_400, noExpression: true },
      {
        name: 'emitWhen',
        label: 'Fire',
        type: 'select',
        default: 'changed',
        noExpression: true,
        options: [
          { label: 'When status or body changes', value: 'changed' },
          { label: 'Every poll', value: 'always' },
        ],
      },
    ],
  },
  async (ctx) => {
    if (ctx.items.length) return { main: ctx.items };
    const url = ctx.param<string>('url');
    const res = await ctx.services.http.request({ method: 'GET', url, signal: ctx.signal, timeoutMs: 15_000 });
    return { main: [{ json: { url, status: res.status, body: res.text().slice(0, 100_000), checkedAt: ctx.clock.now().toISOString() } }] };
  },
);

export const rssPollTrigger = defineNode(
  {
    type: 'core.rssPollTrigger',
    displayName: 'RSS Poll',
    description: 'Polls an RSS/Atom feed and emits only entries not seen before.',
    category: 'trigger',
    icon: 'Rss',
    trigger: 'poll',
    permissions: ['network'],
    parameters: [
      { name: 'url', label: 'Feed URL', type: 'string', required: true },
      { name: 'intervalSeconds', label: 'Interval (seconds)', type: 'number', default: 900, min: 30, max: 86_400, noExpression: true },
    ],
  },
  async (ctx) => {
    if (ctx.items.length) return { main: ctx.items };
    const url = ctx.param<string>('url');
    const res = await ctx.services.http.request({ method: 'GET', url, signal: ctx.signal, timeoutMs: 20_000, maxResponseBytes: 5 * 1024 * 1024 });
    if (res.status >= 400) throw new NodeError('HTTP_ERROR', `Feed returned HTTP ${res.status}`, { retryable: res.status >= 500 });
    return { main: parseFeed(res.text()).map((e) => ({ json: { ...e, feedUrl: url } })) };
  },
);

export const startupTrigger = defineNode(
  {
    type: 'core.startupTrigger',
    displayName: 'App Startup',
    description: 'Runs once each time PulseFlow starts (only while the workflow is active — explicit opt-in).',
    category: 'trigger',
    icon: 'Power',
    trigger: 'startup',
    parameters: [],
  },
  async (ctx) => ({ main: ctx.items.length ? ctx.items : [{ json: { startedAt: ctx.clock.now().toISOString(), manual: true } }] }),
);

export const errorTrigger = defineNode(
  {
    type: 'core.errorTrigger',
    displayName: 'Failure Trigger',
    description: 'Runs when another workflow execution fails. Use it for alerts and recovery.',
    category: 'trigger',
    icon: 'TriangleAlert',
    trigger: 'error',
    parameters: [
      {
        name: 'scope',
        label: 'Watch',
        type: 'select',
        default: 'all',
        noExpression: true,
        options: [
          { label: 'All other workflows', value: 'all' },
          { label: 'Workflows that list this one as their error workflow', value: 'linked' },
        ],
      },
    ],
  },
  async (ctx) => ({
    main: ctx.items.length
      ? ctx.items
      : [{ json: { workflowId: 'example', workflowName: 'Example', executionId: 'exe_example', error: { code: 'EXAMPLE', message: 'Example failure (manual test)' } } }],
  }),
);

export const workflowCalledTrigger = defineNode(
  {
    type: 'core.workflowCalledTrigger',
    displayName: 'Workflow Called',
    description: 'Entry point when this workflow is executed as a sub-workflow. Receives the caller’s items.',
    category: 'trigger',
    icon: 'CornerDownRight',
    trigger: 'called',
    parameters: [],
  },
  async (ctx) => ({ main: passThrough(ctx).length ? ctx.items : [{ json: {} }] }),
);

export const triggerNodes = [
  manualTrigger,
  scheduleTrigger,
  webhookTrigger,
  fileWatchTrigger,
  folderWatchTrigger,
  pollTrigger,
  rssPollTrigger,
  startupTrigger,
  errorTrigger,
  workflowCalledTrigger,
];
