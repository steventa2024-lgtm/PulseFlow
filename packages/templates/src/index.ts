import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { GraphEdge, GraphNode, TemplateInfo, WorkflowGraph } from "@pulseflow/contracts";
import type { PulseStore } from "@pulseflow/storage";

function node(
  id: string,
  manifestId: string,
  x: number,
  y: number,
  parameters: Record<string, unknown>,
  extra: Partial<GraphNode> = {},
): GraphNode {
  return {
    id,
    manifestId,
    manifestVersion: "1.0.0",
    position: { x, y },
    parameters,
    name: id,
    ...extra,
  };
}

function edge(source: string, sourcePort: string, target: string, targetPort = "in", label?: string): GraphEdge {
  return { id: `e_${source}_${sourcePort}_${target}`, source, sourcePort, target, targetPort, label };
}

function graph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  meta: WorkflowGraph["meta"],
  settings: WorkflowGraph["settings"] = {},
): WorkflowGraph {
  return {
    schemaVersion: 1,
    nodes,
    edges,
    meta,
    settings: { concurrency: 1, interruptPolicy: "fail", timezone: "UTC", ...settings },
  };
}

const local = "Runs offline in the app demo folder. No account is required.";

export const templates: TemplateInfo[] = [
  {
    id: "A01",
    tier: "A",
    name: "Hello Automation",
    description: "Manual trigger builds a greeting, takes the true branch, writes JSON, and records a notification.",
    category: "Getting started",
    difficulty: "beginner",
    trigger: "Manual",
    permissions: ["files.write", "notify"],
    services: [],
    setupMinutes: 1,
    offline: true,
    docs: local,
    graph: graph(
      [
        node("manual", "trigger.manual", 80, 180, { payload: { name: "PulseFlow" } }),
        node("set", "logic.set", 340, 180, {
          mode: "merge",
          fields: [{ name: "greeting", value: "Hello, {{ $json.name }}" }],
        }),
        node("check", "logic.if", 620, 180, { expression: '{{ $json.name == "PulseFlow" }}' }),
        node("write", "fs.write", 900, 70, {
          path: "{{ $paths.demo }}/hello-automation.json",
          content: "{{ $json }}",
          format: "json",
        }),
        node("log", "logic.log", 1160, 70, { level: "info", message: "{{ $json.greeting }}" }),
        node("notify", "notify.local", 1420, 70, { title: "PulseFlow", body: "{{ $json.greeting }}" }),
        node("log_false", "logic.log", 900, 320, { level: "info", message: "Condition was false for {{ $json.name }}" }),
      ],
      [
        edge("manual", "out", "set"),
        edge("set", "out", "check"),
        edge("check", "true", "write", "in", "YES"),
        edge("write", "out", "log"),
        edge("log", "out", "notify"),
        edge("check", "false", "log_false", "in", "NO"),
      ],
      { templateId: "A01", tier: "A", category: "Getting started", difficulty: "beginner", description: "Hello Automation" },
    ),
  },
  {
    id: "A02",
    tier: "A",
    name: "Downloads Organizer",
    description: "Classifies a file by extension and moves it into an approved destination. Collisions get a numeric suffix.",
    category: "Files",
    difficulty: "beginner",
    trigger: "Folder changed",
    permissions: ["files.move"],
    services: [],
    setupMinutes: 2,
    offline: true,
    docs: "Default folders live inside the PulseFlow home directory. Add your Downloads folder in Settings before pointing this at personal files.",
    graph: graph(
      [
        node("watch", "trigger.folderChanged", 80, 180, { folder: "{{ $paths.inbox }}" }),
        node("route", "logic.switch", 360, 180, {
          value: "{{ ext($json.path) }}",
          cases: [
            { equals: "pdf", port: "a" },
            { equals: "jpg", port: "b" },
            { equals: "jpeg", port: "b" },
            { equals: "png", port: "b" },
            { equals: "txt", port: "c" },
          ],
        }),
        node("pdf", "fs.move", 680, 40, { toDir: "{{ $paths.out }}/pdf", collision: "suffix", undoManifest: "{{ $paths.out }}/undo-manifest.ndjson" }),
        node("images", "fs.move", 680, 160, { toDir: "{{ $paths.out }}/images", collision: "suffix", undoManifest: "{{ $paths.out }}/undo-manifest.ndjson" }),
        node("text", "fs.move", 680, 280, { toDir: "{{ $paths.out }}/text", collision: "suffix", undoManifest: "{{ $paths.out }}/undo-manifest.ndjson" }),
        node("other", "fs.move", 680, 400, { toDir: "{{ $paths.out }}/other", collision: "suffix", undoManifest: "{{ $paths.out }}/undo-manifest.ndjson" }),
      ],
      [
        edge("watch", "out", "route"),
        edge("route", "a", "pdf"),
        edge("route", "b", "images"),
        edge("route", "c", "text"),
        edge("route", "else", "other"),
      ],
      { templateId: "A02", tier: "A", category: "Files", difficulty: "beginner" },
    ),
  },
  {
    id: "A03",
    tier: "A",
    name: "Batch File Renamer",
    description: "Sanitizes filenames, previews the rename, and applies it only after confirmation.",
    category: "Files",
    difficulty: "intermediate",
    trigger: "Manual",
    permissions: ["files.move"],
    services: [],
    setupMinutes: 2,
    offline: true,
    docs: "Pass dryRun true to preview. Pass confirm RENAME to apply. Rollback uses the undo manifest.",
    graph: graph(
      [
        node("manual", "trigger.manual", 80, 160, { payload: { files: [] } }),
        node("clean", "data.text", 360, 160, { operation: "sanitize", field: "name" }),
        node("rename", "fs.rename", 660, 160, {
          dryRun: "{{ $json.dryRun }}",
          confirm: "{{ $json.confirm }}",
          undoManifest: "{{ $paths.out }}/rename-undo.ndjson",
        }),
      ],
      [edge("manual", "out", "clean"), edge("clean", "out", "rename")],
      { templateId: "A03", tier: "A", category: "Files", difficulty: "intermediate" },
    ),
  },
  {
    id: "A04",
    tier: "A",
    name: "CSV to JSON",
    description: "Reads a CSV file, preserves quoted Unicode fields, and writes JSON.",
    category: "Data",
    difficulty: "beginner",
    trigger: "Manual",
    permissions: ["files.read", "files.write"],
    services: [],
    setupMinutes: 1,
    offline: true,
    docs: local,
    graph: graph(
      [
        node("manual", "trigger.manual", 80, 160, { payload: {} }),
        node("read", "fs.read", 360, 160, { path: "{{ $paths.inbox }}/sample.csv", format: "csv" }),
        node("write", "fs.write", 660, 160, { path: "{{ $paths.demo }}/sample.json", format: "json" }),
      ],
      [edge("manual", "out", "read"), edge("read", "out", "write")],
      { templateId: "A04", tier: "A", category: "Data", difficulty: "beginner" },
    ),
  },
  {
    id: "A05",
    tier: "A",
    name: "JSON to CSV Report",
    description: "Flattens a JSON array and writes an escaped CSV report.",
    category: "Data",
    difficulty: "beginner",
    trigger: "Manual",
    permissions: ["files.read", "files.write"],
    services: [],
    setupMinutes: 1,
    offline: true,
    docs: local,
    graph: graph(
      [
        node("manual", "trigger.manual", 80, 160, { payload: {} }),
        node("read", "fs.read", 340, 160, { path: "{{ $paths.inbox }}/report.json", format: "json" }),
        node("csv", "data.csvWrite", 620, 160, {}),
        node("write", "fs.write", 900, 160, { path: "{{ $paths.demo }}/report.csv", content: "{{ $json.csv }}", format: "text" }),
      ],
      [edge("manual", "out", "read"), edge("read", "out", "csv"), edge("csv", "out", "write")],
      { templateId: "A05", tier: "A", category: "Data", difficulty: "beginner" },
    ),
  },
  {
    id: "A06",
    tier: "A",
    name: "Duplicate Finder",
    description: "Hashes files with SHA-256 and writes a report. It never deletes files.",
    category: "Files",
    difficulty: "intermediate",
    trigger: "Manual",
    permissions: ["files.read", "files.write"],
    services: [],
    setupMinutes: 2,
    offline: true,
    docs: "Deletion is not part of this template. Review the report before doing anything else.",
    graph: graph(
      [
        node("manual", "trigger.manual", 60, 160, { payload: {} }),
        node("scan", "fs.scan", 300, 160, { path: "{{ $paths.inbox }}/dupes" }),
        node("hash", "fs.hash", 540, 160, {}),
        node("group", "logic.aggregate", 780, 160, { mode: "group", expression: "{{ $json.sha256 }}" }),
        node("dups", "logic.filter", 1040, 160, { expression: "{{ $json.count > 1 }}" }),
        node("write", "fs.write", 1300, 160, { path: "{{ $paths.demo }}/duplicates.json", format: "json" }),
      ],
      [
        edge("manual", "out", "scan"),
        edge("scan", "out", "hash"),
        edge("hash", "out", "group"),
        edge("group", "out", "dups"),
        edge("dups", "out", "write"),
      ],
      { templateId: "A06", tier: "A", category: "Files", difficulty: "intermediate" },
    ),
  },
  {
    id: "A07",
    tier: "A",
    name: "Scheduled Desktop Reminder",
    description: "A real cron schedule creates a local notification. The desktop shell shows it when notifications are available.",
    category: "Time",
    difficulty: "beginner",
    trigger: "Schedule",
    permissions: ["notify"],
    services: [],
    setupMinutes: 1,
    offline: true,
    docs: "The schedule runs only while the PulseFlow host process is running. A powered-off computer does not run it.",
    graph: graph(
      [
        node("schedule", "trigger.schedule", 80, 160, { cron: "0 9 * * *", timezone: "UTC", missedPolicy: "skip" }),
        node("notify", "notify.local", 420, 160, { title: "Reminder", body: "PulseFlow reminder {{ $now }}" }),
        node("log", "logic.log", 760, 160, { level: "info", message: "Reminder recorded {{ $now }}" }),
      ],
      [edge("schedule", "out", "notify"), edge("notify", "out", "log")],
      { templateId: "A07", tier: "A", category: "Time", difficulty: "beginner" },
    ),
  },
  {
    id: "A08",
    tier: "A",
    name: "Folder Backup",
    description: "Copies a folder and verifies every SHA-256 digest. The source is left in place.",
    category: "Files",
    difficulty: "beginner",
    trigger: "Manual",
    permissions: ["files.read", "files.write"],
    services: [],
    setupMinutes: 2,
    offline: true,
    docs: local,
    graph: graph(
      [
        node("manual", "trigger.manual", 80, 160, { payload: {} }),
        node("backup", "fs.backup", 400, 160, {
          source: "{{ $paths.inbox }}/backup-src",
          destination: "{{ $paths.backup }}/snapshot",
        }),
        node("log", "logic.log", 760, 160, { level: "info", message: "Backed up {{ $json.files }} files" }),
      ],
      [edge("manual", "out", "backup"), edge("backup", "out", "log")],
      { templateId: "A08", tier: "A", category: "Files", difficulty: "beginner" },
    ),
  },
  {
    id: "A09",
    tier: "A",
    name: "Markdown Daily Report",
    description: "Turns a local JSON document into a timestamped Markdown report.",
    category: "Data",
    difficulty: "beginner",
    trigger: "Manual",
    permissions: ["files.read", "files.write"],
    services: [],
    setupMinutes: 1,
    offline: true,
    docs: local,
    graph: graph(
      [
        node("manual", "trigger.manual", 80, 160, { payload: {} }),
        node("read", "fs.read", 340, 160, { path: "{{ $paths.inbox }}/daily.json", format: "json" }),
        node("markdown", "data.markdown", 640, 160, {
          template: "# Daily report\n\nTitle: {{ $json.title }}\nGenerated: {{ $now }}\n",
        }),
        node("write", "fs.write", 960, 160, { path: "{{ $paths.demo }}/daily.md", content: "{{ $json.markdown }}", format: "text" }),
      ],
      [edge("manual", "out", "read"), edge("read", "out", "markdown"), edge("markdown", "out", "write")],
      { templateId: "A09", tier: "A", category: "Data", difficulty: "beginner" },
    ),
  },
  {
    id: "A10",
    tier: "A",
    name: "Local Webhook Intake",
    description: "Accepts a local POST, validates JSON, appends NDJSON, and returns HTTP 200.",
    category: "Network",
    difficulty: "intermediate",
    trigger: "Webhook",
    permissions: ["webhook", "files.write"],
    services: [],
    setupMinutes: 2,
    offline: true,
    docs: "The hook listens on 127.0.0.1. It is not exposed to the internet in local mode.",
    graph: graph(
      [
        node("hook", "trigger.webhook", 80, 160, {}),
        node("check", "data.schema", 360, 160, {
          schema: {
            type: "object",
            required: ["message"],
            properties: { message: { type: "string" } },
            additionalProperties: true,
          },
        }),
        node("save", "fs.write", 680, 80, { path: "{{ $paths.demo }}/intake.ndjson", content: "{{ $json }}", format: "ndjson" }),
        node("ok", "http.respond", 980, 80, { status: 200, body: { ok: true } }),
        node("bad", "http.respond", 680, 300, { status: 422, body: { ok: false } }),
      ],
      [
        edge("hook", "out", "check"),
        edge("check", "ok", "save"),
        edge("save", "out", "ok"),
        edge("check", "error", "bad"),
      ],
      { templateId: "A10", tier: "A", category: "Network", difficulty: "intermediate" },
    ),
  },
  {
    id: "A11",
    tier: "A",
    name: "Website Response Monitor",
    description: "Compares an HTTP status with the previous sample and notifies on change. Offline runs use the loopback fixture.",
    category: "Network",
    difficulty: "intermediate",
    trigger: "Manual",
    permissions: ["network", "notify"],
    services: ["Loopback fixture"],
    setupMinutes: 2,
    offline: true,
    docs: "Live URLs are optional. The bundled fixture proves change detection without the internet.",
    graph: graph(
      [
        node("manual", "trigger.manual", 60, 180, { payload: {} }),
        node("fetch", "http.request", 320, 180, { url: "{{ $services.fixtureBaseUrl }}/monitor", method: "GET" }),
        node("previous", "data.kv", 600, 180, { action: "get", namespace: "monitor", key: "status" }),
        node("changed", "logic.if", 880, 180, { expression: "{{ $json.body.status != $json.value }}" }),
        node("store", "data.kv", 1160, 80, { action: "set", namespace: "monitor", key: "status", value: "{{ $json.body.status }}" }),
        node("notify", "notify.local", 1440, 80, { title: "Monitor", body: "Status changed to {{ $json.body.status }}" }),
        node("same", "logic.log", 1160, 300, { level: "info", message: "Status unchanged" }),
      ],
      [
        edge("manual", "out", "fetch"),
        edge("fetch", "out", "previous"),
        edge("previous", "out", "changed"),
        edge("changed", "true", "store"),
        edge("store", "out", "notify"),
        edge("changed", "false", "same"),
      ],
      { templateId: "A11", tier: "A", needsFixture: true, category: "Network", difficulty: "intermediate" },
    ),
  },
  {
    id: "A12",
    tier: "A",
    name: "API Health Check",
    description: "Requests fixture endpoints and writes a CSV status report.",
    category: "Network",
    difficulty: "intermediate",
    trigger: "Manual",
    permissions: ["network", "files.write"],
    services: ["Loopback fixture"],
    setupMinutes: 2,
    offline: true,
    docs: "Replace the fixture URLs with your own endpoints when you want a live check.",
    graph: graph(
      [
        node("manual", "trigger.manual", 60, 160, {
          payload: [
            { url: "{{ $services.fixtureBaseUrl }}/health/ok", name: "ok" },
            { url: "{{ $services.fixtureBaseUrl }}/health/bad", name: "bad" },
          ],
        }),
        node("fetch", "http.request", 420, 160, { url: "{{ $json.url }}", method: "GET" }),
        node("csv", "data.csvWrite", 760, 160, {}),
        node("write", "fs.write", 1060, 160, { path: "{{ $paths.demo }}/health.csv", content: "{{ $json.csv }}", format: "text" }),
      ],
      [edge("manual", "out", "fetch"), edge("fetch", "out", "csv"), edge("csv", "out", "write")],
      { templateId: "A12", tier: "A", needsFixture: true, category: "Network", difficulty: "intermediate" },
    ),
  },
  {
    id: "A13",
    tier: "A",
    name: "Log Keyword Watch",
    description: "Reads an approved log and alerts only when the pattern matches.",
    category: "Files",
    difficulty: "intermediate",
    trigger: "Manual",
    permissions: ["files.read", "notify"],
    services: [],
    setupMinutes: 2,
    offline: true,
    docs: local,
    graph: graph(
      [
        node("manual", "trigger.manual", 60, 180, { payload: {} }),
        node("read", "fs.read", 320, 180, { path: "{{ $paths.inbox }}/app.log", format: "text" }),
        node("find", "data.regex", 600, 180, { pattern: "ERROR", text: "{{ $json.text }}" }),
        node("check", "logic.if", 880, 180, { expression: "{{ $json.matched == true }}" }),
        node("notify", "notify.local", 1160, 80, { title: "Log watch", body: "Keyword matched" }),
        node("write", "fs.write", 1440, 80, { path: "{{ $paths.demo }}/log-alert.txt", content: "matched", format: "text" }),
        node("quiet", "logic.log", 1160, 300, { level: "info", message: "No keyword" }),
      ],
      [
        edge("manual", "out", "read"),
        edge("read", "out", "find"),
        edge("find", "out", "check"),
        edge("check", "true", "notify"),
        edge("notify", "out", "write"),
        edge("check", "false", "quiet"),
      ],
      { templateId: "A13", tier: "A", category: "Files", difficulty: "intermediate" },
    ),
  },
  {
    id: "A14",
    tier: "A",
    name: "Personal Task Digest",
    description: "Filters due tasks, sorts them, and writes a Markdown digest.",
    category: "Personal",
    difficulty: "intermediate",
    trigger: "Manual",
    permissions: ["files.read", "files.write"],
    services: [],
    setupMinutes: 2,
    offline: true,
    docs: local,
    graph: graph(
      [
        node("manual", "trigger.manual", 40, 160, { payload: {} }),
        node("read", "fs.read", 280, 160, { path: "{{ $paths.inbox }}/tasks.json", format: "json" }),
        node("due", "logic.filter", 540, 160, { expression: "{{ $json.due <= slice($now, 0, 10) && $json.done == false }}" }),
        node("sort", "logic.sort", 800, 160, { expression: "{{ $json.due }}", order: "asc" }),
        node("collect", "logic.aggregate", 1040, 160, { mode: "collect" }),
        node("markdown", "data.markdown", 1280, 160, { template: "# Task digest\n\n{{ json($json.items) }}\n" }),
        node("write", "fs.write", 1540, 160, { path: "{{ $paths.demo }}/digest.md", content: "{{ $json.markdown }}", format: "text" }),
      ],
      [
        edge("manual", "out", "read"),
        edge("read", "out", "due"),
        edge("due", "out", "sort"),
        edge("sort", "out", "collect"),
        edge("collect", "out", "markdown"),
        edge("markdown", "out", "write"),
      ],
      { templateId: "A14", tier: "A", category: "Personal", difficulty: "intermediate" },
    ),
  },
  {
    id: "A15",
    tier: "A",
    name: "RSS to Reading List",
    description: "Reads a feed, drops ids it has already seen, and saves the new items.",
    category: "Network",
    difficulty: "intermediate",
    trigger: "Manual",
    permissions: ["network", "files.write"],
    services: ["Loopback fixture"],
    setupMinutes: 2,
    offline: true,
    docs: "The bundled feed is deterministic. A public feed can be substituted when the network is available.",
    graph: graph(
      [
        node("manual", "trigger.manual", 60, 160, { payload: {} }),
        node("feed", "rss.read", 340, 160, { url: "{{ $services.fixtureBaseUrl }}/rss" }),
        node("dedupe", "logic.dedupe", 640, 160, { expression: "{{ $json.guid }}", mode: "persistent" }),
        node("write", "fs.write", 940, 160, { path: "{{ $paths.demo }}/reading-list.json", format: "json" }),
      ],
      [edge("manual", "out", "feed"), edge("feed", "out", "dedupe"), edge("dedupe", "out", "write")],
      { templateId: "A15", tier: "A", needsFixture: true, category: "Network", difficulty: "intermediate" },
    ),
  },
  {
    id: "A16",
    tier: "A",
    name: "Error Recovery Example",
    description: "A transient fault retries with backoff and then succeeds. Attempts stay visible in the execution inspector.",
    category: "Reliability",
    difficulty: "intermediate",
    trigger: "Manual",
    permissions: [],
    services: [],
    setupMinutes: 1,
    offline: true,
    docs: "External delivery is at least once. This example only shows the local retry state machine.",
    graph: graph(
      [
        node("manual", "trigger.manual", 80, 160, { payload: { name: "retry" } }),
        node("fault", "logic.transient", 400, 160, { failTimes: 2 }, {
          retry: { maxAttempts: 4, backoffMs: 5, jitter: false, maxBackoffMs: 1000 },
        }),
        node("log", "logic.log", 760, 160, { level: "info", message: "Recovered on attempt {{ $json.attempt }}" }),
      ],
      [edge("manual", "out", "fault"), edge("fault", "out", "log")],
      { templateId: "A16", tier: "A", category: "Reliability", difficulty: "intermediate" },
    ),
  },
  {
    id: "B01",
    tier: "B",
    name: "GitHub Issue to Local Task",
    description: "Demo mode reads fixture issues and writes local tasks. Live mode needs a GitHub token.",
    category: "GitHub",
    difficulty: "intermediate",
    trigger: "Manual",
    permissions: ["network", "files.write"],
    services: ["GitHub"],
    setupMinutes: 5,
    offline: false,
    credentialKind: "github",
    docs: "Try demo uses the local fixture. Run live calls api.github.com and is subject to GitHub rate limits.",
    graph: graph(
      [
        node("manual", "trigger.manual", 60, 160, { payload: {} }),
        node("issues", "github.api", 340, 160, { resource: "issues", owner: "acme", repo: "demo" }),
        node("dedupe", "logic.dedupe", 640, 160, { expression: "{{ $json.id }}", mode: "persistent" }),
        node("write", "fs.write", 940, 160, { path: "{{ $paths.demo }}/github-tasks.json", format: "json" }),
      ],
      [edge("manual", "out", "issues"), edge("issues", "out", "dedupe"), edge("dedupe", "out", "write")],
      { templateId: "B01", tier: "B", needsFixture: true, credentialKind: "github", category: "GitHub", difficulty: "intermediate" },
    ),
  },
  {
    id: "B02",
    tier: "B",
    name: "GitHub Release Watch",
    description: "Stores a release digest and notifies once per release id.",
    category: "GitHub",
    difficulty: "intermediate",
    trigger: "Manual",
    permissions: ["network", "notify", "files.write"],
    services: ["GitHub"],
    setupMinutes: 5,
    offline: false,
    credentialKind: "github",
    docs: "Public repositories can be queried without a token until GitHub rate-limits the address. Demo mode does not contact GitHub.",
    graph: graph(
      [
        node("manual", "trigger.manual", 60, 160, { payload: {} }),
        node("releases", "github.api", 340, 160, { resource: "releases", owner: "acme", repo: "demo" }),
        node("dedupe", "logic.dedupe", 660, 160, { expression: "{{ $json.id }}", mode: "persistent" }),
        node("write", "fs.write", 960, 160, { path: "{{ $paths.demo }}/releases.json", format: "json" }),
        node("notify", "notify.local", 1240, 160, { title: "Release", body: "{{ $json.tag_name }}" }),
      ],
      [
        edge("manual", "out", "releases"),
        edge("releases", "out", "dedupe"),
        edge("dedupe", "out", "write"),
        edge("write", "out", "notify"),
      ],
      { templateId: "B02", tier: "B", needsFixture: true, credentialKind: "github", category: "GitHub", difficulty: "intermediate" },
    ),
  },
  {
    id: "B03",
    tier: "B",
    name: "RSS to Discord",
    description: "Formats new feed items and posts them to a Discord webhook. Demo mode captures the post locally.",
    category: "Notifications",
    difficulty: "intermediate",
    trigger: "Manual",
    permissions: ["network"],
    services: ["Discord"],
    setupMinutes: 5,
    offline: false,
    credentialKind: "discord",
    docs: "Use a webhook you control. PulseFlow does not bypass Discord rate limits.",
    graph: graph(
      [
        node("manual", "trigger.manual", 60, 160, { payload: {} }),
        node("feed", "rss.read", 320, 160, { url: "{{ $services.fixtureBaseUrl }}/rss" }),
        node("dedupe", "logic.dedupe", 600, 160, { expression: "{{ $json.guid }}", mode: "persistent" }),
        node("post", "discord.webhook", 900, 160, { content: "{{ $json.title }} — {{ $json.link }}" }),
      ],
      [edge("manual", "out", "feed"), edge("feed", "out", "dedupe"), edge("dedupe", "out", "post")],
      { templateId: "B03", tier: "B", needsFixture: true, credentialKind: "discord", category: "Notifications", difficulty: "intermediate" },
    ),
  },
  {
    id: "B04",
    tier: "B",
    name: "Form Webhook to SMTP",
    description: "Validates intake JSON and sends mail through the user's SMTP server. Demo mode uses a local SMTP sink.",
    category: "Email",
    difficulty: "advanced",
    trigger: "Webhook",
    permissions: ["webhook", "email", "network"],
    services: ["SMTP"],
    setupMinutes: 10,
    offline: false,
    credentialKind: "smtp",
    docs: "Live mode needs your SMTP host. The demo does not send mail to the public internet.",
    graph: graph(
      [
        node("hook", "trigger.webhook", 60, 160, {}),
        node("check", "data.schema", 340, 160, {
          schema: {
            type: "object",
            required: ["email", "message"],
            properties: { email: { type: "string" }, message: { type: "string" } },
          },
        }),
        node("send", "email.smtp", 680, 80, {
          host: "{{ $services.smtpHost }}",
          port: "{{ $services.smtpPort }}",
          from: "pulseflow@localhost",
          to: "{{ $json.email }}",
          subject: "PulseFlow received your note",
          text: "{{ $json.message }}",
        }),
      ],
      [edge("hook", "out", "check"), edge("check", "ok", "send")],
      { templateId: "B04", tier: "B", needsFixture: true, needsSmtp: true, credentialKind: "smtp", category: "Email", difficulty: "advanced" },
    ),
  },
  {
    id: "B05",
    tier: "B",
    name: "Spreadsheet Sync",
    description: "Reads sheet values from the demo fixture or, in live mode, from an API base URL stored on a credential.",
    category: "Data",
    difficulty: "advanced",
    trigger: "Manual",
    permissions: ["network", "files.write"],
    services: ["Spreadsheet"],
    setupMinutes: 15,
    offline: false,
    credentialKind: "sheets",
    docs: "Google Sheets live access needs a user-registered OAuth client and is subject to Google quota. Demo mode never contacts Google.",
    graph: graph(
      [
        node("manual", "trigger.manual", 60, 160, { payload: {} }),
        node("read", "sheets.sync", 360, 160, { action: "read" }),
        node("write", "fs.write", 700, 160, { path: "{{ $paths.demo }}/sheet.json", format: "json" }),
      ],
      [edge("manual", "out", "read"), edge("read", "out", "write")],
      { templateId: "B05", tier: "B", needsFixture: true, credentialKind: "sheets", category: "Data", difficulty: "advanced" },
    ),
  },
  {
    id: "B06",
    tier: "B",
    name: "Telegram Alert Bot",
    description: "Sends an alert through a Telegram bot. Demo mode records the provider payload locally.",
    category: "Notifications",
    difficulty: "intermediate",
    trigger: "Manual",
    permissions: ["network"],
    services: ["Telegram"],
    setupMinutes: 5,
    offline: false,
    credentialKind: "telegram",
    docs: "Live mode needs the bot token and a chat that has started the bot. PulseFlow does not create Telegram accounts.",
    graph: graph(
      [
        node("manual", "trigger.manual", 60, 160, { payload: { text: "PulseFlow alert" } }),
        node("send", "telegram.send", 400, 160, { chatId: "demo-chat", text: "{{ $json.text }}" }),
        node("log", "logic.log", 760, 160, { level: "info", message: "Telegram status {{ $json.status }}" }),
      ],
      [edge("manual", "out", "send"), edge("send", "out", "log")],
      { templateId: "B06", tier: "B", needsFixture: true, credentialKind: "telegram", category: "Notifications", difficulty: "intermediate" },
    ),
  },
  {
    id: "B07",
    tier: "B",
    name: "Local Ollama Summarizer",
    description: "Summarizes a local text file. Demo mode uses a fixture. Live mode calls a local Ollama server if you installed one.",
    category: "AI",
    difficulty: "intermediate",
    trigger: "Manual",
    permissions: ["files.read", "files.write", "ai"],
    services: ["Ollama"],
    setupMinutes: 5,
    offline: true,
    docs: "PulseFlow runs without Ollama. Live summarization needs a model you have already pulled and enough memory to load it.",
    graph: graph(
      [
        node("manual", "trigger.manual", 60, 160, { payload: {} }),
        node("read", "fs.read", 320, 160, { path: "{{ $paths.inbox }}/notes.txt", format: "text" }),
        node("summarize", "ai.ollama", 640, 160, { prompt: "Summarize: {{ $json.text }}", model: "fixture" }),
        node("markdown", "data.markdown", 960, 160, { template: "# Summary\n\n{{ $json.summary }}\n" }),
        node("write", "fs.write", 1240, 160, { path: "{{ $paths.demo }}/summary.md", content: "{{ $json.markdown }}", format: "text" }),
      ],
      [
        edge("manual", "out", "read"),
        edge("read", "out", "summarize"),
        edge("summarize", "out", "markdown"),
        edge("markdown", "out", "write"),
      ],
      { templateId: "B07", tier: "B", needsFixture: true, category: "AI", difficulty: "intermediate" },
    ),
  },
  {
    id: "B08",
    tier: "B",
    name: "Browser Data Capture",
    description: "Demo mode fetches HTML and extracts the title and links. It does not evade access controls or CAPTCHAs.",
    category: "Browser",
    difficulty: "advanced",
    trigger: "Manual",
    permissions: ["network", "files.write"],
    services: ["Loopback fixture"],
    setupMinutes: 5,
    offline: true,
    docs: "Live Playwright automation is a separate opt-in and is not implied by a successful demo run.",
    graph: graph(
      [
        node("manual", "trigger.manual", 60, 160, { payload: {} }),
        node("extract", "browser.extract", 380, 160, { url: "{{ $services.fixtureBaseUrl }}/page" }),
        node("write", "fs.write", 740, 160, { path: "{{ $paths.demo }}/page.csv", content: "{{ $json.csv }}", format: "text" }),
      ],
      [edge("manual", "out", "extract"), edge("extract", "out", "write")],
      { templateId: "B08", tier: "B", needsFixture: true, category: "Browser", difficulty: "advanced" },
    ),
  },
];

export function getTemplate(id: string): TemplateInfo | undefined {
  return templates.find((template) => template.id === id);
}

export function seedWorkspace(store: PulseStore, home: string): void {
  mkdirSync(path.join(home, "demo"), { recursive: true });
  mkdirSync(path.join(home, "inbox"), { recursive: true });
  mkdirSync(path.join(home, "out"), { recursive: true });
  mkdirSync(path.join(home, "backup"), { recursive: true });
  const identity = store.ensureLocalIdentity();
  for (const folder of ["demo", "inbox", "out", "backup"]) {
    store.addRoot(`root_${folder}`, path.join(home, folder), folder);
  }
  writeDemoFixtures(home);
  if (store.countWorkflows() > 0) return;
  for (const template of templates) {
    store.insertWorkflow({
      id: workflowIdFor(template.id),
      workspaceId: identity.workspaceId,
      projectId: identity.projectId,
      name: template.name,
      description: template.description,
      tags: [template.tier, template.category, template.id],
      graph: template.graph,
      ownerId: identity.userId,
    });
  }
  store.setSetting("tutorialDismissed", false);
  store.setSetting("telemetry", false);
  store.setSetting("backgroundExecution", false);
  store.setSetting("retentionDays", 30);
  store.audit({
    id: "aud_seed",
    workspaceId: identity.workspaceId,
    actorId: identity.userId,
    action: "workspace.seeded",
    detail: { templates: templates.length },
  });
}

export function workflowIdFor(templateId: string): string {
  return `wf_${templateId.toLowerCase()}`;
}

export function writeDemoFixtures(home: string): void {
  const inbox = path.join(home, "inbox");
  const write = (relative: string, contents: string) => {
    const file = path.join(inbox, relative);
    if (existsSync(file)) return;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, contents);
  };
  write("sample.csv", 'name,note\nAda,"She said ""hello"""\nGrace,café\n');
  write("report.json", JSON.stringify([{ name: "Ada", note: 'say "hi"' }], null, 2));
  write("dupes/a.txt", "same");
  write("dupes/b.txt", "same");
  write("dupes/c.txt", "different");
  write("backup-src/keep.txt", "keep");
  write("daily.json", JSON.stringify({ title: "Monday" }));
  write("app.log", "info started\nERROR disk full\n");
  write(
    "tasks.json",
    JSON.stringify(
      [
        { title: "Write report", due: "2026-10-11", done: false },
        { title: "Future", due: "2027-01-01", done: false },
        { title: "Pay invoice", due: "2026-10-01", done: false },
        { title: "Done task", due: "2026-09-01", done: true },
      ],
      null,
      2,
    ),
  );
  write("notes.txt", "A local note worth summarizing.");
  write("loose.png", "png");
  write("rename-me.txt", "name");
}
