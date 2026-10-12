import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import type { Item } from '@pulseflow/contracts';
import { NodeError, type NodeExecutionContext } from '@pulseflow/engine';
import { defineNode, requireString } from './helpers';

function assertAdvancedAllowed(ctx: NodeExecutionContext): void {
  if (!ctx.services.advancedNodesEnabled) {
    throw new NodeError('ADVANCED_DISABLED', 'Advanced-risk nodes are disabled. Enable them in Settings → Advanced (they can run arbitrary programs).');
  }
  if (!ctx.settings.permissions.advancedNodes) {
    throw new NodeError('PERMISSION_DENIED', 'This workflow is not permitted to run advanced-risk nodes (Workflow → Permissions).');
  }
}

export const sqliteQueryNode = defineNode(
  {
    type: 'core.sqliteQuery',
    displayName: 'SQLite Query',
    description: 'Runs a parameterized query against a SQLite file in a granted folder. Read-only unless you choose "Execute".',
    category: 'developer',
    icon: 'DatabaseZap',
    permissions: ['fs.read'],
    parameters: [
      { name: 'database', label: 'Database file', type: 'path', required: true },
      {
        name: 'operation',
        label: 'Operation',
        type: 'select',
        default: 'select',
        noExpression: true,
        options: [
          { label: 'Select (read-only)', value: 'select' },
          { label: 'Execute (insert/update/delete — modifies the file)', value: 'execute' },
        ],
      },
      {
        name: 'query',
        label: 'SQL',
        type: 'code',
        required: true,
        noExpression: true,
        default: 'SELECT 1 AS one',
        description: 'Use ? placeholders; values come from Parameters.',
      },
      { name: 'parameters', label: 'Parameters (list)', type: 'text', default: '{{ [] }}' },
    ],
  },
  async (ctx) => {
    const op = ctx.param<string>('operation');
    const dbPath = requireString(ctx.param('database'), 'Database file');
    const real = op === 'execute' ? ctx.services.fs.resolveWrite(dbPath) : ctx.services.fs.resolveRead(dbPath);
    const db = new DatabaseSync(real, { readOnly: op !== 'execute' });
    try {
      const out: Item[] = [];
      const sql = String(ctx.rawParam('query'));
      if (/;\s*\S/.test(sql.trim().replace(/;\s*$/, ''))) throw new NodeError('MULTIPLE_STATEMENTS', 'Only one SQL statement per node is allowed');
      const stmt = db.prepare(sql);
      for (let i = 0; i < ctx.items.length; i++) {
        const params = ctx.param('parameters', i);
        const list = (Array.isArray(params) ? params : []).map((v) =>
          typeof v === 'boolean' ? (v ? 1 : 0) : v === undefined ? null : typeof v === 'object' && v !== null ? JSON.stringify(v) : v,
        ) as (string | number | null)[];
        if (op === 'select') {
          for (const row of stmt.all(...list).slice(0, ctx.settings.maxItemsPerNode)) out.push({ json: { ...(row as Record<string, unknown>) } });
        } else {
          const r = stmt.run(...list);
          out.push({ json: { ...ctx.items[i]!.json, changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) } });
        }
      }
      return { main: out };
    } catch (e) {
      if (e instanceof NodeError) throw e;
      throw new NodeError('SQLITE_ERROR', (e as Error).message);
    } finally {
      db.close();
    }
  },
);

function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    else process.kill(-pid, 'SIGKILL');
  } catch {
    // process already exited
  }
}

interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

function runProcess(
  command: string,
  args: string[],
  opts: { cwd?: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxOutput: number; input?: string; signal: AbortSignal },
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const cap = (cur: string, chunk: Buffer) => (cur.length < opts.maxOutput ? cur + chunk.toString('utf8').slice(0, opts.maxOutput - cur.length) : cur);
    child.stdout.on('data', (c: Buffer) => (stdout = cap(stdout, c)));
    child.stderr.on('data', (c: Buffer) => (stderr = cap(stderr, c)));
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, opts.timeoutMs);
    const onAbort = () => killTree(child.pid);
    opts.signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => {
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', onAbort);
      reject(new NodeError('SPAWN_FAILED', `Could not start "${command}": ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', onAbort);
      resolve({ exitCode: code, stdout, stderr, timedOut, durationMs: Date.now() - started });
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

const minimalEnv = (): NodeJS.ProcessEnv => {
  const keep = ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LANG', 'PATHEXT', 'COMSPEC'];
  return Object.fromEntries(keep.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
};

export const shellNode = defineNode(
  {
    type: 'core.shell',
    displayName: 'Run Program (advanced)',
    description:
      'ADVANCED RISK: runs a local program with arguments (no shell interpolation). Disabled by default. Not a sandbox — the program runs with your user account’s rights.',
    category: 'developer',
    icon: 'SquareTerminal',
    permissions: ['advanced'],
    risk: 'advanced',
    sideEffects: 'Runs an arbitrary program on this computer.',
    parameters: [
      { name: 'command', label: 'Program', type: 'string', required: true, noExpression: true, placeholder: 'git' },
      { name: 'args', label: 'Arguments', type: 'stringList', default: [] },
      { name: 'cwd', label: 'Working folder', type: 'path' },
      { name: 'timeoutMs', label: 'Timeout (ms)', type: 'number', default: 30_000, min: 100, max: 3_600_000, noExpression: true },
      { name: 'failOnNonZero', label: 'Fail on non-zero exit code', type: 'boolean', default: true, noExpression: true },
    ],
  },
  async (ctx) => {
    assertAdvancedAllowed(ctx);
    const out: Item[] = [];
    for (let i = 0; i < ctx.items.length; i++) {
      const cwdRaw = ctx.param<string>('cwd', i);
      const cwd = cwdRaw ? ctx.services.fs.resolveRead(cwdRaw) : undefined;
      const args = (ctx.param<unknown[]>('args', i) ?? []).map(String);
      const res = await runProcess(String(ctx.rawParam('command')), args, {
        cwd,
        env: minimalEnv(),
        timeoutMs: ctx.param<number>('timeoutMs'),
        maxOutput: 1_000_000,
        signal: ctx.signal,
      });
      if (res.timedOut) throw new NodeError('PROCESS_TIMEOUT', `Program exceeded ${ctx.param<number>('timeoutMs')} ms and was terminated`);
      if (ctx.param('failOnNonZero') && res.exitCode !== 0) throw new NodeError('PROCESS_FAILED', `Exit code ${res.exitCode}: ${res.stderr.slice(0, 500)}`);
      out.push({ json: { ...ctx.items[i]!.json, exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr, durationMs: res.durationMs } });
    }
    return { main: out };
  },
);

const CODE_RUNNER = `
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', async () => {
  try {
    const { code, items } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const fn = new AsyncFunction('items', '"use strict";\\n' + code);
    const result = await fn(items);
    process.stdout.write(JSON.stringify({ ok: true, result: result === undefined ? items : result }));
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: String(e && e.stack || e) }));
  }
});
`;

export const codeNode = defineNode(
  {
    type: 'core.code',
    displayName: 'Code (advanced)',
    description:
      'ADVANCED RISK: runs JavaScript in a separate Node process with the Node permission model (no file system writes, no child processes, no workers) and a memory/time cap. Network access is NOT blocked. This is a seat belt, not a security sandbox — only run code you trust.',
    category: 'developer',
    icon: 'Code',
    permissions: ['advanced'],
    risk: 'advanced',
    parameters: [
      {
        name: 'code',
        label: 'JavaScript',
        type: 'code',
        required: true,
        noExpression: true,
        default: '// `items` is an array of { json } objects. Return the new list.\nreturn items.map((it) => ({ json: { ...it.json, processed: true } }));',
      },
      { name: 'timeoutMs', label: 'Timeout (ms)', type: 'number', default: 10_000, min: 100, max: 600_000, noExpression: true },
      { name: 'memoryMb', label: 'Memory limit (MB)', type: 'number', default: 128, min: 32, max: 2048, noExpression: true },
    ],
  },
  async (ctx) => {
    assertAdvancedAllowed(ctx);
    const permFlag = process.allowedNodeEnvironmentFlags.has('--permission') ? '--permission' : '--experimental-permission';
    const env: NodeJS.ProcessEnv = { ...minimalEnv(), ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) };
    const res = await runProcess(
      process.execPath,
      [permFlag, `--max-old-space-size=${ctx.param<number>('memoryMb')}`, '--disable-warning=ExperimentalWarning', '-e', CODE_RUNNER],
      {
        env,
        timeoutMs: ctx.param<number>('timeoutMs'),
        maxOutput: 50 * 1024 * 1024,
        input: JSON.stringify({ code: ctx.rawParam('code'), items: ctx.items }),
        signal: ctx.signal,
      },
    );
    if (res.timedOut) throw new NodeError('CODE_TIMEOUT', `Code exceeded ${ctx.param<number>('timeoutMs')} ms and was terminated`);
    let parsed: { ok: boolean; result?: unknown; error?: string };
    try {
      parsed = JSON.parse(res.stdout) as typeof parsed;
    } catch {
      throw new NodeError('CODE_FAILED', `Code process exited (${res.exitCode}) without a result. ${res.stderr.slice(0, 500)}`);
    }
    if (!parsed.ok) throw new NodeError('CODE_ERROR', (parsed.error ?? 'Unknown error').slice(0, 2000));
    if (!Array.isArray(parsed.result)) throw new NodeError('CODE_INVALID_RESULT', 'Code must return an array of { json } items');
    return { main: parsed.result as Item[] };
  },
);

export const developerNodes = [sqliteQueryNode, shellNode, codeNode];
