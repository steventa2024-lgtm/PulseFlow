import type { TemplateManifest } from '@pulseflow/contracts';
import { chain, edge, node, t, X, Y } from './builders';

/**
 * Tier B templates talk to third-party services. Each one has two clearly separate modes:
 * - Live: the user supplies their own credential/account; nothing is pre-filled.
 * - Demo: `demoOverrides` point the workflow at PulseFlow's bundled loopback fixtures, which
 *   imitate the provider's API shape. Demo runs are labelled as such everywhere in the UI.
 */

export const B01 = t({
  id: 'B01',
  slug: 'github-release-digest',
  name: 'GitHub Release Digest',
  description: 'Collects the latest releases of a GitHub repository into a Markdown digest.',
  category: 'Developer',
  tier: 'B',
  difficulty: 'beginner',
  triggerType: 'Manual or schedule',
  permissions: ['HTTP requests to api.github.com', 'Write the digest'],
  services: ['GitHub REST API (public repos work without a token; a token raises rate limits)'],
  setupMinutes: 2,
  tags: ['github', 'releases', 'markdown'],
  liveRequirements: 'Internet access. Optional: a GitHub personal access token (read-only, public_repo) selected on the GitHub node.',
  variables: [
    { name: 'owner', label: 'Owner', kind: 'string', default: 'nodejs' },
    { name: 'repo', label: 'Repository', kind: 'string', default: 'node' },
    {
      name: 'apiBaseUrl',
      label: 'GitHub API base URL',
      kind: 'url',
      default: 'https://api.github.com',
      description: 'Demo mode points this at the bundled fixture.',
    },
    { name: 'outputFile', label: 'Digest file', kind: 'file', default: '${templateDir}/release-digest.md', access: 'readwrite' },
  ],
  demoOverrides: { apiBaseUrl: '${fixturesUrl}/github', owner: 'pulseflow-demo', repo: 'sample' },
  requiredCredentials: [{ type: 'githubToken', label: 'GitHub token (optional)' }],
  sample: { input: 'owner/repo', output: 'release-digest.md listing the 10 most recent releases' },
  docs: 'Lists releases via `GET /repos/{owner}/{repo}/releases` (follows `Link: rel="next"` pagination) and writes tag, name, date and URL. Unauthenticated requests are limited to 60/hour by GitHub; the node logs the remaining quota. **Demo mode** uses a bundled fixture that returns sample releases — no network access.',
  workflow: {
    name: 'GitHub Release Digest',
    description: 'GitHub releases → Markdown → file',
    graph: {
      schemaVersion: 1,
      nodes: [
        node('manual', 'core.manualTrigger', 'Build Digest', X(0), Y(0)),
        node('schedule', 'core.scheduleTrigger', 'Weekly Monday 08:00', X(0), Y(2), { mode: 'cron', cron: '0 8 * * 1', missedRunPolicy: 'skip' }),
        node(
          'releases',
          'connector.github',
          'List Releases',
          X(1),
          Y(1),
          { operation: 'listReleases', owner: '{{ $vars.owner }}', repo: '{{ $vars.repo }}', limit: 10, credential: '', apiBaseUrl: '{{ $vars.apiBaseUrl }}' },
          { retry: { maxAttempts: 3, initialDelayMs: 1000 } },
        ),
        node('md', 'core.markdown', 'Digest', X(2), Y(1), {
          title: 'Releases of {{ $vars.owner }}/{{ $vars.repo }} — {{ $today }}',
          intro: '',
          itemTemplate: '- **{{ $json.tag_name }}** {{ $json.name ?? "" }} ({{ formatDate($json.published_at, "yyyy-MM-dd") }}) — {{ $json.html_url }}',
          emptyText: '_No releases found._',
          footer: '',
        }),
        node('write', 'core.fileWrite', 'Save Digest', X(3), Y(1), { path: '{{ $vars.outputFile }}', content: '{{ $json.markdown }}', mode: 'overwrite' }),
      ],
      edges: [edge('manual', 'releases'), edge('schedule', 'releases'), ...chain('releases', 'md', 'write')],
    },
    settings: {},
  },
});

export const B02 = t({
  id: 'B02',
  slug: 'rss-to-discord',
  name: 'RSS to Discord',
  description: 'Posts new RSS entries to a Discord channel through a channel webhook.',
  category: 'Content',
  tier: 'B',
  difficulty: 'beginner',
  triggerType: 'Manual or RSS poll',
  permissions: ['HTTP requests', 'Post to Discord'],
  services: ['Discord channel webhook'],
  setupMinutes: 3,
  tags: ['rss', 'discord', 'dedupe'],
  liveRequirements: 'A Discord webhook (Channel settings → Integrations → Webhooks) saved as a "Discord webhook" credential and selected on the Discord node.',
  variables: [
    { name: 'feedUrl', label: 'Feed URL', kind: 'url', default: '${fixturesUrl}/feed.xml' },
    {
      name: 'demoWebhookUrl',
      label: 'Demo webhook URL',
      kind: 'url',
      default: '',
      description: 'Only used in demo mode. Live mode uses the selected credential.',
    },
  ],
  demoOverrides: { demoWebhookUrl: '${fixturesUrl}/discord/webhook' },
  requiredCredentials: [{ type: 'discordWebhook', label: 'Discord webhook' }],
  sample: { input: 'RSS feed', output: 'One Discord message per new entry (no duplicates across runs)' },
  docs: 'New entries are deduplicated persistently, then posted one message each with mentions disabled. Discord rate limits (HTTP 429) are retried after the `Retry-After` delay. **Demo mode** posts to a bundled loopback fixture that records messages instead of Discord.',
  workflow: {
    name: 'RSS to Discord',
    description: 'RSS → dedupe → Discord',
    graph: {
      schemaVersion: 1,
      nodes: [
        node('manual', 'core.manualTrigger', 'Fetch Now', X(0), Y(0)),
        node('poll', 'core.rssPollTrigger', 'Poll Feed', X(0), Y(2), { url: '{{ $vars.feedUrl }}', intervalSeconds: 1800 }),
        node('read', 'core.rssRead', 'Read Feed', X(1), Y(0), { url: '{{ $vars.feedUrl }}', limit: 20 }),
        node('dedupe', 'core.dedupe', 'Only New', X(2), Y(1), { key: '{{ $json.id }}', scope: 'persistent' }),
        node('limit', 'core.filter', 'At Most 5 per Run', X(3), Y(1), { conditions: [{ left: '{{ $item.index }}', operator: 'lt', right: '5' }] }),
        node(
          'post',
          'connector.discordWebhook',
          'Post to Discord',
          X(4),
          Y(1),
          { credential: '', webhookUrlOverride: '{{ $vars.demoWebhookUrl }}', content: '**{{ $json.title }}**\n{{ $json.link }}', username: 'PulseFlow' },
          { retry: { maxAttempts: 3, initialDelayMs: 1000 } },
        ),
      ],
      edges: [edge('manual', 'read'), edge('read', 'dedupe'), edge('poll', 'dedupe'), ...chain('dedupe', 'limit', 'post')],
    },
    settings: {},
  },
});

export const B03 = t({
  id: 'B03',
  slug: 'website-monitor-telegram',
  name: 'Website Monitor → Telegram',
  description: 'Checks a URL and sends a Telegram message when it is down or recovers.',
  category: 'Monitoring',
  tier: 'B',
  difficulty: 'intermediate',
  triggerType: 'Interval',
  permissions: ['HTTP requests', 'Send Telegram messages'],
  services: ['Telegram Bot API'],
  setupMinutes: 5,
  tags: ['monitor', 'telegram', 'alerts'],
  liveRequirements: 'A Telegram bot token from @BotFather saved as a "Telegram bot" credential, and your chat ID.',
  variables: [
    { name: 'url', label: 'URL to monitor', kind: 'url', default: '${fixturesUrl}/monitor' },
    { name: 'chatId', label: 'Telegram chat ID', kind: 'string', default: '' },
    { name: 'telegramApi', label: 'Telegram API base URL', kind: 'url', default: 'https://api.telegram.org' },
    { name: 'demoToken', label: 'Demo bot token', kind: 'string', default: '', description: 'Only used in demo mode.' },
  ],
  demoOverrides: { telegramApi: '${fixturesUrl}/telegram', demoToken: 'demo-token', chatId: '424242' },
  requiredCredentials: [{ type: 'telegramBot', label: 'Telegram bot' }],
  sample: { input: 'GET url', output: 'Telegram message "DOWN: … (503)" and later "RECOVERED: … (200)"' },
  docs: 'Stores the last up/down state; only transitions produce a message. **Demo mode** sends to a bundled fixture of the Bot API (`/bot<token>/sendMessage`) — nothing leaves your machine.',
  workflow: {
    name: 'Website Monitor → Telegram',
    description: 'HTTP → state change → Telegram',
    graph: {
      schemaVersion: 1,
      nodes: [
        node('manual', 'core.manualTrigger', 'Check Now', X(0), Y(0)),
        node('every', 'core.scheduleTrigger', 'Every 5 Minutes', X(0), Y(2), { mode: 'interval', intervalSeconds: 300 }),
        node(
          'get',
          'core.httpRequest',
          'GET URL',
          X(1),
          Y(1),
          { method: 'GET', url: '{{ $vars.url }}', failOnError: false, timeoutMs: 10_000, responseFormat: 'text' },
          { onError: 'continue' },
        ),
        node('state', 'core.set', 'Up?', X(2), Y(1), {
          keepExisting: true,
          fields: [{ name: 'up', value: '{{ ($json.status ?? 0) >= 200 && ($json.status ?? 0) < 400 }}' }],
        }),
        node('last', 'core.kv', 'Last State', X(3), Y(1), { operation: 'get', key: 'up', target: 'wasUp' }),
        node('save', 'core.kv', 'Save State', X(4), Y(1), { operation: 'set', key: 'up', value: '{{ $json.up }}', target: 'savedUp' }),
        node('changed', 'core.if', 'Changed?', X(5), Y(1), {
          conditions: [{ left: '{{ $json.wasUp != null && $json.wasUp != $json.up }}', operator: 'isTrue' }],
        }),
        node(
          'send',
          'connector.telegram',
          'Send Telegram',
          X(6),
          Y(0),
          {
            credential: '',
            demoToken: '{{ $vars.demoToken }}',
            chatId: '{{ $vars.chatId }}',
            text: '{{ $json.up ? "RECOVERED" : "DOWN" }}: {{ $vars.url }} ({{ $json.status ?? "no response" }})',
            apiBaseUrl: '{{ $vars.telegramApi }}',
          },
          { retry: { maxAttempts: 3, initialDelayMs: 1000 } },
        ),
      ],
      edges: [edge('manual', 'get'), edge('every', 'get'), ...chain('get', 'state', 'last', 'save', 'changed'), edge('changed', 'send', 'true')],
    },
    settings: {},
  },
});

export const B04 = t({
  id: 'B04',
  slug: 'daily-email-digest',
  name: 'Daily Email Digest',
  description: 'Emails yourself a daily digest of open tasks through your own SMTP account.',
  category: 'Productivity',
  tier: 'B',
  difficulty: 'intermediate',
  triggerType: 'Manual or schedule',
  permissions: ['Read tasks.json', 'Send email'],
  services: ['Your SMTP server (e.g. your email provider)'],
  setupMinutes: 5,
  tags: ['email', 'smtp', 'digest'],
  liveRequirements: 'An SMTP credential (host, port, user, app password). Enable Permissions → Email for the workflow.',
  variables: [
    { name: 'tasksFile', label: 'Tasks file', kind: 'file', default: '${templateDir}/tasks.json', access: 'read' },
    {
      name: 'smtpCredential',
      label: 'SMTP credential ID',
      kind: 'string',
      default: '',
      description: 'Select your SMTP account on the Send Email node or paste its ID here.',
    },
    { name: 'from', label: 'From', kind: 'string', default: 'me@example.com' },
    { name: 'to', label: 'To', kind: 'string', default: 'me@example.com' },
  ],
  demoOverrides: { smtpCredential: 'cred_demo_smtp' },
  fixtures: {
    'tasks.json': `${JSON.stringify(
      [
        { id: 1, title: 'Water the plants', done: false },
        { id: 2, title: 'Reply to Sam', done: false },
        { id: 3, title: 'File taxes', done: true },
      ],
      null,
      2,
    )}\n`,
  },
  requiredCredentials: [{ type: 'smtp', label: 'SMTP account' }],
  sample: { input: 'tasks.json', output: 'One email listing the open tasks' },
  docs: 'Mail is sent through **your** SMTP server via nodemailer (STARTTLS when offered). PulseFlow never relays mail itself. **Demo mode** uses a credential pointing at a bundled loopback SMTP sink that only records the message locally (visible under Templates → B04 → Demo outbox).',
  workflow: {
    name: 'Daily Email Digest',
    description: 'Read tasks → open only → compose → email',
    graph: {
      schemaVersion: 1,
      nodes: [
        node('manual', 'core.manualTrigger', 'Send Now', X(0), Y(0)),
        node('schedule', 'core.scheduleTrigger', 'Daily 07:30', X(0), Y(2), { mode: 'cron', cron: '30 7 * * *', missedRunPolicy: 'skip' }),
        node('read', 'core.fileRead', 'Read Tasks', X(1), Y(1), { path: '{{ $vars.tasksFile }}', format: 'jsonItems' }),
        node('open', 'core.filter', 'Open Tasks', X(2), Y(1), { conditions: [{ left: '{{ $json.done }}', operator: 'isFalse' }] }),
        node('md', 'core.markdown', 'Compose', X(3), Y(1), {
          title: 'Your tasks for {{ $today }}',
          intro: '',
          itemTemplate: '- {{ $json.title }}',
          emptyText: 'Nothing open today.',
          footer: '— sent by PulseFlow',
        }),
        node('mail', 'core.emailSend', 'Send Email', X(4), Y(1), {
          credential: '{{ $vars.smtpCredential }}',
          from: '{{ $vars.from }}',
          to: '{{ $vars.to }}',
          subject: 'Task digest — {{ $today }} ({{ $json.itemCount }} open)',
          text: '{{ $json.markdown }}',
        }),
      ],
      edges: [edge('manual', 'read'), edge('schedule', 'read'), ...chain('read', 'open', 'md', 'mail')],
    },
    settings: { permissions: { fs: [], allowPrivateNetwork: false, notifications: true, email: true, advancedNodes: false } },
  },
});

export const B05 = t({
  id: 'B05',
  slug: 'form-to-google-sheets',
  name: 'Webhook Form → Google Sheets',
  description: 'Appends each webhook submission as a row in a Google Sheet via the Sheets API.',
  category: 'Integrations',
  tier: 'B',
  difficulty: 'advanced',
  triggerType: 'Webhook or manual',
  permissions: ['Local HTTP endpoint', 'HTTP requests to sheets.googleapis.com'],
  services: ['Google Sheets API v4'],
  setupMinutes: 15,
  tags: ['google', 'sheets', 'webhook'],
  liveRequirements:
    'A Google OAuth access token with the spreadsheets scope saved as a "Bearer token" credential and selected on the Append Row node, plus the spreadsheet ID. PulseFlow does not yet run the Google OAuth flow for you (see ROADMAP), and access tokens expire after about an hour.',
  variables: [
    { name: 'spreadsheetId', label: 'Spreadsheet ID', kind: 'string', default: '' },
    { name: 'range', label: 'Sheet range', kind: 'string', default: 'Sheet1!A:D' },
    { name: 'sheetsApi', label: 'Sheets API base URL', kind: 'url', default: 'https://sheets.googleapis.com' },
  ],
  demoOverrides: { sheetsApi: '${fixturesUrl}/sheets', spreadsheetId: 'demo-sheet' },
  requiredCredentials: [{ type: 'httpBearer', label: 'Google OAuth access token' }],
  sample: { input: { name: 'Ada', email: 'ada@example.com', message: 'Hi' }, output: 'A new row in the sheet; webhook replies with the updated range' },
  docs: 'Calls `POST /v4/spreadsheets/{id}/values/{range}:append?valueInputOption=RAW`. Values are sent RAW so user input is never interpreted as formulas. **Demo mode** appends to a bundled fixture that stores rows in memory and returns the same response shape.',
  workflow: {
    name: 'Webhook Form → Google Sheets',
    description: 'Webhook → row → Sheets append → respond',
    graph: {
      schemaVersion: 1,
      nodes: [
        node('hook', 'core.webhookTrigger', 'Form Submission', X(0), Y(0), { method: 'POST', responseMode: 'lastNode', auth: 'none', maxBodyKb: 64 }),
        node('manual', 'core.manualTrigger', 'Test Row', X(0), Y(2), {
          sampleData: { body: { name: 'Ada', email: 'ada@example.com', message: 'Hello from PulseFlow' } },
        }),
        node('row', 'core.set', 'Row Values', X(1), Y(1), {
          keepExisting: false,
          fields: [
            { name: 'values', value: '{{ [[ $now, string($json.body.name ?? ""), string($json.body.email ?? ""), string($json.body.message ?? "") ]] }}' },
          ],
        }),
        node(
          'append',
          'core.httpRequest',
          'Append Row',
          X(2),
          Y(1),
          {
            method: 'POST',
            url: '{{ $vars.sheetsApi }}/v4/spreadsheets/{{ $vars.spreadsheetId }}/values/{{ $vars.range }}:append',
            query: [{ name: 'valueInputOption', value: 'RAW' }],
            headers: [],
            bodyMode: 'json',
            body: '{{ { values: $json.values } }}',
            credential: '',
            failOnError: true,
            timeoutMs: 20_000,
            responseFormat: 'json',
          },
          { retry: { maxAttempts: 3, initialDelayMs: 1000 } },
        ),
        node('result', 'core.set', 'Result', X(3), Y(1), {
          keepExisting: false,
          fields: [
            { name: 'ok', value: '{{ true }}' },
            { name: 'updatedRange', value: '{{ $json.body.updates.updatedRange }}' },
          ],
        }),
      ],
      edges: [edge('hook', 'row'), edge('manual', 'row'), ...chain('row', 'append', 'result')],
    },
    settings: {},
  },
});

export const B06 = t({
  id: 'B06',
  slug: 'local-ai-note-summarizer',
  name: 'Local AI Note Summarizer',
  description: 'Summarizes every Markdown note in a folder with a local Ollama model — no cloud AI.',
  category: 'AI',
  tier: 'B',
  difficulty: 'intermediate',
  triggerType: 'Manual',
  permissions: ['Read notes', 'Write summaries', 'HTTP to 127.0.0.1:11434 (Ollama)'],
  services: ['Ollama running locally (free, optional)'],
  setupMinutes: 10,
  tags: ['ai', 'ollama', 'local', 'markdown'],
  liveRequirements: 'Ollama installed and running (ollama.com) with a model pulled, e.g. `ollama pull llama3.2:3b`. Inference runs on your hardware.',
  variables: [
    { name: 'notesDir', label: 'Notes folder', kind: 'folder', default: '${templateDir}/notes', access: 'read' },
    { name: 'outputFile', label: 'Summary file', kind: 'file', default: '${templateDir}/summaries.md', access: 'readwrite' },
    { name: 'ollamaUrl', label: 'Ollama URL', kind: 'url', default: 'http://127.0.0.1:11434' },
    { name: 'model', label: 'Model', kind: 'string', default: 'llama3.2:3b' },
  ],
  demoOverrides: { ollamaUrl: '${fixturesUrl}/ollama', model: 'demo-fixture' },
  fixtures: {
    'notes/meeting.md': '# Team sync\n\nWe agreed to ship the beta on Friday. Sam owns release notes. Risks: flaky CI on Windows.\n',
    'notes/ideas.md': '# Ideas\n\n- Offline mode for the mobile app\n- Dark theme refresh\n- Weekly digest email\n',
  },
  sample: { input: 'notes/*.md', output: 'summaries.md with one summary per note' },
  docs: 'Each note is sent to `POST /api/generate` on your local Ollama. Model output is treated as untrusted text: it is written to the summary file, never executed. If Ollama is not running the node fails with setup instructions. **Demo mode** uses a bundled fixture that returns a deterministic extractive summary (first sentences) — it is not an AI model and says so in its output.',
  workflow: {
    name: 'Local AI Note Summarizer',
    description: 'Scan notes → read → Ollama summarize → Markdown',
    graph: {
      schemaVersion: 1,
      nodes: [
        node('manual', 'core.manualTrigger', 'Summarize', X(0), Y(1)),
        node('scan', 'core.directoryScan', 'Find Notes', X(1), Y(1), { folder: '{{ $vars.notesDir }}', recursive: false, extensions: ['.md', '.txt'] }),
        node('read', 'core.fileRead', 'Read Note', X(2), Y(1), { path: '{{ $json.path }}', format: 'text', target: 'content' }),
        node('ai', 'ai.ollama', 'Summarize with Ollama', X(3), Y(1), {
          baseUrl: '{{ $vars.ollamaUrl }}',
          model: '{{ $vars.model }}',
          task: 'summarize',
          input: '{{ $json.content }}',
          instructions: 'Two sentences, plain text.',
          target: 'ai',
          timeoutMs: 180_000,
          maxInputChars: 20_000,
        }),
        node('md', 'core.markdown', 'Summaries', X(4), Y(1), {
          title: 'Note summaries — {{ $today }}',
          intro: 'Model: {{ $vars.model }}',
          itemTemplate: '## {{ $json.file.name }}\n\n{{ $json.ai.result }}\n',
          emptyText: '_No notes found._',
          footer: '',
        }),
        node('write', 'core.fileWrite', 'Save', X(5), Y(1), { path: '{{ $vars.outputFile }}', content: '{{ $json.markdown }}', mode: 'overwrite' }),
      ],
      edges: chain('manual', 'scan', 'read', 'ai', 'md', 'write'),
    },
    settings: { maxParallelNodes: 1 },
  },
});

export const B07 = t({
  id: 'B07',
  slug: 'github-issue-triage',
  name: 'GitHub Issue Triage Report',
  description: 'Lists open issues, labels each with a local AI model and writes a CSV triage report.',
  category: 'Developer',
  tier: 'B',
  difficulty: 'advanced',
  triggerType: 'Manual',
  permissions: ['HTTP requests to GitHub', 'HTTP to local Ollama', 'Write the report'],
  services: ['GitHub REST API', 'Ollama (local)'],
  setupMinutes: 10,
  tags: ['github', 'ai', 'csv'],
  liveRequirements: 'Internet access for GitHub (token optional) and Ollama running locally with a model pulled.',
  variables: [
    { name: 'owner', label: 'Owner', kind: 'string', default: 'nodejs' },
    { name: 'repo', label: 'Repository', kind: 'string', default: 'node' },
    { name: 'apiBaseUrl', label: 'GitHub API base URL', kind: 'url', default: 'https://api.github.com' },
    { name: 'ollamaUrl', label: 'Ollama URL', kind: 'url', default: 'http://127.0.0.1:11434' },
    { name: 'model', label: 'Model', kind: 'string', default: 'llama3.2:3b' },
    { name: 'reportFile', label: 'Report', kind: 'file', default: '${templateDir}/triage.csv', access: 'readwrite' },
  ],
  demoOverrides: { apiBaseUrl: '${fixturesUrl}/github', owner: 'pulseflow-demo', repo: 'sample', ollamaUrl: '${fixturesUrl}/ollama', model: 'demo-fixture' },
  requiredCredentials: [{ type: 'githubToken', label: 'GitHub token (optional)' }],
  sample: { input: 'owner/repo', output: 'triage.csv: number, title, label (bug/feature/question/docs), url' },
  docs: 'Classification is constrained to the label set; anything else becomes empty rather than trusted. **Demo mode** uses the GitHub and Ollama fixtures (the Ollama fixture classifies by keyword and is not an AI model).',
  workflow: {
    name: 'GitHub Issue Triage Report',
    description: 'GitHub issues → AI classify → CSV',
    graph: {
      schemaVersion: 1,
      nodes: [
        node('manual', 'core.manualTrigger', 'Triage', X(0), Y(1)),
        node('issues', 'connector.github', 'Open Issues', X(1), Y(1), {
          operation: 'listIssues',
          owner: '{{ $vars.owner }}',
          repo: '{{ $vars.repo }}',
          state: 'open',
          limit: 20,
          credential: '',
          apiBaseUrl: '{{ $vars.apiBaseUrl }}',
        }),
        node('ai', 'ai.ollama', 'Classify', X(2), Y(1), {
          baseUrl: '{{ $vars.ollamaUrl }}',
          model: '{{ $vars.model }}',
          task: 'classify',
          input: '{{ $json.title }}\n\n{{ substring(string($json.body ?? ""), 0, 2000) }}',
          labels: 'bug, feature, question, docs',
          target: 'ai',
          timeoutMs: 120_000,
          maxInputChars: 4000,
        }),
        node('row', 'core.set', 'Row', X(3), Y(1), {
          keepExisting: false,
          fields: [
            { name: 'number', value: '{{ $json.number }}' },
            { name: 'title', value: '{{ $json.title }}' },
            { name: 'label', value: '{{ $json.ai.result ?? "" }}' },
            { name: 'url', value: '{{ $json.html_url }}' },
          ],
        }),
        node('csv', 'core.csv', 'CSV', X(4), Y(1), { operation: 'build', columns: ['number', 'title', 'label', 'url'], escapeFormulas: true }),
        node('write', 'core.fileWrite', 'Save', X(5), Y(1), { path: '{{ $vars.reportFile }}', content: '{{ $json.csv }}', mode: 'overwrite' }),
      ],
      edges: chain('manual', 'issues', 'ai', 'row', 'csv', 'write'),
    },
    settings: { maxParallelNodes: 1 },
  },
});

export const TIER_B: TemplateManifest[] = [B01, B02, B03, B04, B05, B06, B07];

/** Catalog entries that are designed but not implemented. They are shown as "Planned" and cannot be instantiated. */
export interface PlannedTemplate {
  id: string;
  name: string;
  description: string;
  status: 'planned';
  reason: string;
}

export const PLANNED_TEMPLATES: PlannedTemplate[] = [
  {
    id: 'B08',
    name: 'Browser Automation: Price Watch',
    description: 'Open a page in a real browser, read a price you select, and alert on drops.',
    status: 'planned',
    reason:
      'Requires the optional Playwright browser-automation pack, which is not implemented yet. It will only automate sites you are authorized to use and will never bypass CAPTCHAs or bot protections.',
  },
];
