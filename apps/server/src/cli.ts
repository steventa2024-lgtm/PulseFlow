import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkflowBundleSchema, WorkflowGraphSchema, type WorkflowGraph } from '@pulseflow/contracts';
import { validateGraph } from '@pulseflow/engine';
import { connectorNodes } from '@pulseflow/connectors';
import { createCoreRegistry } from '@pulseflow/nodes-core';
import { openDatabase } from '@pulseflow/storage';
import { TEMPLATES } from '@pulseflow/templates';
import { APP_VERSION, buildConfig, defaultDataDir } from './config';
import { createHost } from './host';

interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2) as [string, string | undefined];
      if (v !== undefined) out.flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1]!.startsWith('--')) out.flags[k] = argv[++i]!;
      else out.flags[k] = true;
    } else out._.push(a);
  }
  return out;
}

const HELP = `PulseFlow ${APP_VERSION} — local-first workflow automation

Usage: pulseflow <command> [options]

Commands
  serve                 Start the local API + UI server
      --port <n>          Port (default: random free port)
      --host <addr>       Bind address (default 127.0.0.1)
      --data-dir <dir>    Data directory (default: ${defaultDataDir()})
      --static <dir>      Serve a built renderer from <dir>
      --server            Server mode (user accounts + RBAC instead of a local token)
      --no-fixtures       Disable the /demo fixture endpoints
  doctor                Check the runtime, data directory and database
  validate <file>       Validate a workflow bundle or graph JSON file
  run <file|id>         Run a workflow once and print the result (exit 1 on failure)
      --input <json>      Trigger payload
  templates             List built-in templates
  templates:test        Run every template that has a manual trigger (demo mode) and report
  export <id...> --out <file>   Export workflows (never includes secrets)
  import <file>         Import a bundle (workflows start inactive with no permissions)
  backup [--out <file>] Write a consistent copy of the database
  migrate               Apply database migrations and print the schema version
`;

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')) as unknown;
}

function graphsFrom(raw: unknown): { name: string; graph: WorkflowGraph }[] {
  const bundle = WorkflowBundleSchema.safeParse(raw);
  if (bundle.success) return bundle.data.workflows.map((w) => ({ name: w.name, graph: w.graph }));
  const graph = WorkflowGraphSchema.safeParse((raw as { graph?: unknown }).graph ?? raw);
  if (graph.success) return [{ name: String((raw as { name?: string }).name ?? 'workflow'), graph: graph.data }];
  throw new Error(`Not a PulseFlow bundle or graph: ${graph.error.issues[0]?.message ?? 'invalid'}`);
}

async function withHost<T>(args: Args, fn: (host: Awaited<ReturnType<typeof createHost>>) => Promise<T>, opts: { temp?: boolean } = {}): Promise<T> {
  const dataDir = opts.temp ? fs.mkdtempSync(path.join(os.tmpdir(), 'pulseflow-cli-')) : String(args.flags['data-dir'] ?? defaultDataDir());
  const host = await createHost(buildConfig({ dataDir, port: 0, logLevel: 'silent' }), { startTriggers: false, log: () => undefined });
  try {
    return await fn(host);
  } finally {
    await host.close();
    if (opts.temp) fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const cmd = args._[0] ?? 'help';
  switch (cmd) {
    case 'help':
    case '--help':
      console.log(HELP);
      return 0;

    case 'serve': {
      const config = buildConfig({
        dataDir: String(args.flags['data-dir'] ?? defaultDataDir()),
        ...(args.flags.port ? { port: Number(args.flags.port) } : {}),
        ...(args.flags.host ? { host: String(args.flags.host) } : {}),
        ...(args.flags.static ? { staticDir: path.resolve(String(args.flags.static)) } : {}),
        ...(args.flags.server ? { mode: 'server' as const } : {}),
        ...(args.flags['no-fixtures'] ? { fixtures: false } : {}),
      });
      if (config.mode === 'local' && config.host !== '127.0.0.1' && config.host !== 'localhost') {
        console.error('Refusing to bind a local-mode server to a non-loopback address. Use --server for multi-user mode.');
        return 2;
      }
      const host = await createHost(config);
      console.log(`PulseFlow ${APP_VERSION} listening on ${host.url}`);
      if (config.mode === 'local') console.log(`Open: ${host.url}/#token=${config.localToken}`);
      else console.log(host.ctx.auth.needsSetup() ? `Create the owner account at ${host.url}` : 'Server mode: sign in with your account');
      console.log(`Data: ${config.dataDir}`);
      const stop = () => {
        console.log('Shutting down…');
        void host.close().then(() => process.exit(0));
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      return await new Promise<number>(() => undefined);
    }

    case 'doctor': {
      const checks: [string, boolean, string][] = [];
      const major = Number(process.versions.node.split('.')[0]);
      checks.push(['Node.js >= 22', major >= 22, process.versions.node]);
      let sqliteOk = false;
      try {
        await import('node:sqlite');
        sqliteOk = true;
      } catch {
        sqliteOk = false;
      }
      checks.push(['node:sqlite available', sqliteOk, sqliteOk ? 'yes' : 'missing']);
      const dataDir = String(args.flags['data-dir'] ?? defaultDataDir());
      let writable = false;
      try {
        fs.mkdirSync(dataDir, { recursive: true });
        fs.accessSync(dataDir, fs.constants.W_OK);
        writable = true;
      } catch {
        writable = false;
      }
      checks.push(['Data directory writable', writable, dataDir]);
      if (sqliteOk && writable) {
        const db = openDatabase(path.join(dataDir, 'pulseflow.db'));
        db.migrate();
        checks.push(['Database integrity', db.integrityCheck() === 'ok', `schema v${db.schemaVersion()}`]);
        db.close();
      }
      checks.push(['Templates load', TEMPLATES.length > 0, `${TEMPLATES.length} templates`]);
      const reg = createCoreRegistry(connectorNodes);
      checks.push(['Node registry', reg.list().length > 0, `${reg.list().length} node types`]);
      checks.push(['Telemetry', true, 'none (PulseFlow sends no telemetry)']);
      for (const [name, ok, detail] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(28)} ${detail}`);
      return checks.every((c) => c[1]) ? 0 : 1;
    }

    case 'validate': {
      const file = args._[1];
      if (!file) throw new Error('Usage: pulseflow validate <file>');
      const reg = createCoreRegistry(connectorNodes);
      let failed = false;
      for (const { name, graph } of graphsFrom(readJson(file))) {
        const r = validateGraph(graph, reg, { requireTrigger: true });
        console.log(`${r.ok ? 'VALID  ' : 'INVALID'} ${name}`);
        for (const i of r.issues) console.log(`  ${i.severity.toUpperCase()} ${i.code}: ${i.message}`);
        failed ||= !r.ok;
      }
      return failed ? 1 : 0;
    }

    case 'run': {
      const target = args._[1];
      if (!target) throw new Error('Usage: pulseflow run <file|workflowId>');
      const input = args.flags.input ? (JSON.parse(String(args.flags.input)) as Record<string, unknown>) : undefined;
      const isFile = fs.existsSync(target);
      return withHost(
        args,
        async (host) => {
          let wfId = target;
          if (isFile) {
            const graphs = graphsFrom(readJson(target));
            wfId = host.ctx.workflows.create({ name: graphs[0]!.name, draft: graphs[0]!.graph }, 'cli').id;
          }
          const rec = host.ctx.workflows.run(wfId, { useDraft: true, wait: false, ...(input ? { payload: input } : {}) }, 'cli');
          const done = await host.ctx.executions.waitFor(rec.id, 30 * 60_000);
          for (const s of host.ctx.store.steps.list(done.id))
            console.log(`${s.state.padEnd(10)} ${s.nodeName}${s.attempt > 1 ? ` (attempt ${s.attempt})` : ''}${s.error ? ` — ${s.error.message}` : ''}`);
          console.log(`Execution ${done.id}: ${done.state}${done.error ? ` — ${done.error.message}` : ''}`);
          return done.state === 'succeeded' ? 0 : 1;
        },
        { temp: isFile && !args.flags['data-dir'] },
      );
    }

    case 'templates':
      for (const t of TEMPLATES) console.log(`${t.id}  ${t.name.padEnd(34)} ${t.tier === 'A' ? 'offline' : 'connected (demo available)'}  ${t.triggerType}`);
      return 0;

    case 'templates:test':
      return withHost(
        args,
        async (host) => {
          let failures = 0;
          for (const t of TEMPLATES) {
            if (!t.workflow.graph.nodes.some((n) => n.type === 'core.manualTrigger')) {
              console.log(`SKIP  ${t.id} ${t.name} (no manual trigger; covered by the E2E suite)`);
              continue;
            }
            const { workflow } = host.ctx.workflows.instantiateTemplate(t.id, { demo: true }, 'cli');
            const rec = host.ctx.workflows.run(workflow.id, { useDraft: true, wait: false }, 'cli');
            const done = await host.ctx.executions.waitFor(rec.id, 120_000);
            const ok = done.state === 'succeeded';
            if (!ok) failures++;
            console.log(`${ok ? 'PASS' : 'FAIL'}  ${t.id} ${t.name}${ok ? '' : ` — ${done.error?.message ?? done.state}`}`);
          }
          return failures ? 1 : 0;
        },
        { temp: true },
      );

    case 'export': {
      const ids = args._.slice(1);
      const out = args.flags.out ? String(args.flags.out) : null;
      if (!ids.length || !out) throw new Error('Usage: pulseflow export <id...> --out <file>');
      return withHost(args, async (host) => {
        fs.writeFileSync(path.resolve(out), `${JSON.stringify(host.ctx.workflows.exportBundle(ids), null, 2)}\n`);
        console.log(`Exported ${ids.length} workflow(s) to ${out}`);
        return 0;
      });
    }

    case 'import': {
      const file = args._[1];
      if (!file) throw new Error('Usage: pulseflow import <file>');
      return withHost(args, async (host) => {
        const r = host.ctx.workflows.importBundle(readJson(file), 'cli');
        for (const w of r.workflows)
          console.log(`Imported ${w.id} ${w.name}${r.issues[w.id]?.length ? ` (${r.issues[w.id]!.length} validation issue(s))` : ''}`);
        return 0;
      });
    }

    case 'backup':
      return withHost(args, async (host) => {
        const file = host.ctx.backup();
        const dest = args.flags.out ? path.resolve(String(args.flags.out)) : file;
        if (dest !== file) fs.renameSync(file, dest);
        console.log(`Backup written to ${dest}`);
        return 0;
      });

    case 'migrate': {
      const dataDir = String(args.flags['data-dir'] ?? defaultDataDir());
      fs.mkdirSync(dataDir, { recursive: true });
      const db = openDatabase(path.join(dataDir, 'pulseflow.db'));
      db.migrate();
      console.log(`Schema version ${db.schemaVersion()}`);
      db.close();
      return 0;
    }

    default:
      console.error(`Unknown command "${cmd}"\n`);
      console.log(HELP);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  },
);
