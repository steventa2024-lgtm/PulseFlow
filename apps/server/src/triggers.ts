import fs from 'node:fs';
import { newToken, type Item, type NodeInstance, type Workflow, type WorkflowVersion } from '@pulseflow/contracts';
import {
  missedRuns,
  nextCronRun,
  resolveTemplate,
  type Clock,
  type HttpClient,
  type MissedRunPolicy,
  type NodeRegistry,
  type ScopedFs,
} from '@pulseflow/engine';
import { parseFeed } from '@pulseflow/nodes-core';
import { sha256Hex } from '@pulseflow/security';
import type { Store } from '@pulseflow/storage';
import type { ExecutionService } from './executions';

const MAX_TIMER_MS = 2 ** 31 - 1;

export interface TriggerDeps {
  store: Store;
  clock: Clock;
  registry: NodeRegistry;
  executions: ExecutionService;
  makeFs: (wf: Workflow) => ScopedFs;
  makeHttp: (wf: Workflow) => HttpClient;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
  app: { demoDir: string; dataDir: string; fixturesUrl: string };
}

export interface TriggerStatus {
  nodeId: string;
  kind: string;
  lastCheckAt: string | null;
  lastFiredAt: string | null;
  lastError: string | null;
  nextRunAt?: string | null;
  webhookPath?: string;
}

type Cleanup = () => void;

function same(a: { size: number; modifiedAt: string }, b: { size: number; modifiedAt: string }) {
  return a.size === b.size && a.modifiedAt === b.modifiedAt;
}

export class TriggerManager {
  readonly #handles = new Map<string, Cleanup[]>();

  constructor(private readonly deps: TriggerDeps) {}

  #ns(wfId: string, nodeId: string) {
    return `trigger:${wfId}:${nodeId}`;
  }

  #status(wfId: string, nodeId: string, patch: Partial<TriggerStatus>): void {
    const ns = this.#ns(wfId, nodeId);
    const cur = (this.deps.store.kv.get(ns, 'status') as TriggerStatus | undefined) ?? {
      nodeId,
      kind: '',
      lastCheckAt: null,
      lastFiredAt: null,
      lastError: null,
    };
    this.deps.store.kv.set(ns, 'status', { ...cur, ...patch });
  }

  statuses(wfId: string): TriggerStatus[] {
    const wf = this.deps.store.workflows.get(wfId);
    if (!wf?.publishedVersionId) return [];
    const version = this.deps.store.versions.get(wf.publishedVersionId);
    if (!version) return [];
    return this.#triggerNodes(version).map((n) => {
      const st = (this.deps.store.kv.get(this.#ns(wfId, n.id), 'status') as TriggerStatus | undefined) ?? {
        nodeId: n.id,
        kind: n.type,
        lastCheckAt: null,
        lastFiredAt: null,
        lastError: null,
      };
      const sched = this.deps.store.schedules.get(wfId, n.id);
      const hook = this.deps.store.webhooks.forWorkflow(wfId).find((h) => h.node_id === n.id);
      return {
        ...st,
        nodeId: n.id,
        kind: n.type,
        ...(sched ? { nextRunAt: wf.active ? sched.next_run_at : null } : {}),
        ...(hook ? { webhookPath: `/hooks/${hook.token}` } : {}),
      };
    });
  }

  #triggerNodes(version: WorkflowVersion): NodeInstance[] {
    return version.graph.nodes.filter((n) => !n.disabled && this.deps.registry.get(n.type)?.manifest.trigger);
  }

  #fire(wf: Workflow, version: WorkflowVersion, node: NodeInstance, items: Item[]): void {
    try {
      this.deps.executions.enqueue({
        workflowId: wf.id,
        workflowName: wf.name,
        versionId: version.id,
        graph: version.graph,
        settings: version.settings,
        triggerNodeId: node.id,
        items,
        mode: 'trigger',
      });
      this.#status(wf.id, node.id, { lastFiredAt: this.deps.clock.now().toISOString(), lastError: null });
    } catch (e) {
      this.#status(wf.id, node.id, { lastError: (e as Error).message });
      this.deps.log('warn', `Trigger ${node.name} could not enqueue: ${(e as Error).message}`);
    }
  }

  /** Re-arms a callback every `ms`, never overlapping a still-running tick. */
  #every(ms: number, tick: () => Promise<void>): Cleanup {
    let stopped = false;
    let handle: unknown;
    const arm = () => {
      if (stopped) return;
      handle = this.deps.clock.setTimeout(() => {
        void tick()
          .catch(() => undefined)
          .finally(arm);
      }, ms);
    };
    arm();
    return () => {
      stopped = true;
      if (handle !== undefined) this.deps.clock.clearTimeout(handle);
    };
  }

  /** Arms a one-shot timer at `at`, chaining for delays longer than setTimeout allows. */
  #at(at: Date, fn: () => void): Cleanup {
    let handle: unknown;
    let stopped = false;
    const arm = () => {
      const delay = at.getTime() - this.deps.clock.now().getTime();
      handle = this.deps.clock.setTimeout(
        () => {
          if (stopped) return;
          if (delay > MAX_TIMER_MS) arm();
          else fn();
        },
        Math.max(0, Math.min(delay, MAX_TIMER_MS)),
      );
    };
    arm();
    return () => {
      stopped = true;
      if (handle !== undefined) this.deps.clock.clearTimeout(handle);
    };
  }

  startAll(opts: { startup: boolean }): void {
    for (const wf of this.deps.store.workflows.listActive()) {
      try {
        this.activate(wf, opts);
      } catch (e) {
        this.deps.log('error', `Could not activate ${wf.name}: ${(e as Error).message}`);
      }
    }
  }

  activate(wf: Workflow, opts: { startup?: boolean } = {}): void {
    this.deactivate(wf.id);
    if (!wf.publishedVersionId) throw new Error('Workflow has no published version');
    const version = this.deps.store.versions.get(wf.publishedVersionId);
    if (!version) throw new Error('Published version missing');
    const cleanups: Cleanup[] = [];
    this.#handles.set(wf.id, cleanups);
    const tz = version.settings.timezone;
    for (const node of this.#triggerNodes(version)) {
      const p = node.parameters;
      switch (node.type) {
        case 'core.scheduleTrigger':
          cleanups.push(this.#armSchedule(wf, version, node, tz, opts.startup === true));
          break;
        case 'core.webhookTrigger':
          this.deps.store.webhooks.ensure(wf.id, node.id, newToken(24));
          break;
        case 'core.fileWatchTrigger':
          cleanups.push(this.#armFileWatch(wf, version, node));
          break;
        case 'core.folderWatchTrigger':
          cleanups.push(this.#armFolderWatch(wf, version, node));
          break;
        case 'core.httpPollTrigger':
          cleanups.push(this.#armHttpPoll(wf, version, node));
          break;
        case 'core.rssPollTrigger':
          cleanups.push(this.#armRssPoll(wf, version, node));
          break;
        case 'core.startupTrigger':
          if (opts.startup) this.#fire(wf, version, node, [{ json: { startedAt: this.deps.clock.now().toISOString() } }]);
          break;
        default:
          void p;
      }
    }
  }

  deactivate(wfId: string): void {
    for (const c of this.#handles.get(wfId) ?? []) c();
    this.#handles.delete(wfId);
    for (const s of this.deps.store.schedules.forWorkflow(wfId)) {
      this.deps.store.schedules.markRun(wfId, s.node_id, s.last_run_at ?? '', null);
    }
  }

  stopAll(): void {
    for (const id of [...this.#handles.keys()]) {
      for (const c of this.#handles.get(id) ?? []) c();
    }
    this.#handles.clear();
  }

  isArmed(wfId: string): boolean {
    return this.#handles.has(wfId);
  }

  #armSchedule(wf: Workflow, version: WorkflowVersion, node: NodeInstance, tz: string, startup: boolean): Cleanup {
    const p = node.parameters;
    const mode = (p.mode as string) ?? 'interval';
    const policy = ((p.missedRunPolicy as string) ?? 'skip') as MissedRunPolicy;
    const now = this.deps.clock.now();
    const prior = this.deps.store.schedules.get(wf.id, node.id);
    const expression = mode === 'cron' ? String(p.cron ?? '') : `every ${Number(p.intervalSeconds ?? 300)}s`;
    const changed = prior && prior.expression !== expression;
    const lastRun = prior?.last_run_at && !changed ? new Date(prior.last_run_at) : null;

    const computeNext = (after: Date): Date | null => {
      if (mode === 'cron') return nextCronRun(expression, tz, after);
      return new Date(after.getTime() + Math.max(1, Number(p.intervalSeconds ?? 300)) * 1000);
    };

    if (startup && lastRun && policy === 'runOnce') {
      const due =
        mode === 'cron' ? missedRuns(expression, tz, lastRun, now, policy) : computeNext(lastRun)!.getTime() <= now.getTime() ? [computeNext(lastRun)!] : [];
      if (due.length) {
        this.deps.log('info', `${wf.name}: running 1 missed schedule (${due[0]!.toISOString()})`);
        this.#fire(wf, version, node, [{ json: { firedAt: now.toISOString(), scheduledFor: due[0]!.toISOString(), missed: true } }]);
      }
    }

    let cleanup: Cleanup = () => undefined;
    let stopped = false;
    const schedule = (after: Date) => {
      const next = computeNext(after);
      this.deps.store.schedules.upsert({
        workflow_id: wf.id,
        node_id: node.id,
        kind: mode,
        expression,
        timezone: tz,
        next_run_at: next?.toISOString() ?? null,
        last_run_at: null,
      });
      if (!next || stopped) return;
      cleanup = this.#at(next, () => {
        const firedAt = this.deps.clock.now();
        this.#fire(wf, version, node, [{ json: { firedAt: firedAt.toISOString(), scheduledFor: next.toISOString(), timezone: tz } }]);
        const following = computeNext(next.getTime() > firedAt.getTime() ? next : firedAt);
        this.deps.store.schedules.markRun(wf.id, node.id, firedAt.toISOString(), following?.toISOString() ?? null);
        schedule(next.getTime() > firedAt.getTime() ? next : firedAt);
      });
    };
    schedule(now);
    return () => {
      stopped = true;
      cleanup();
    };
  }

  #armFileWatch(wf: Workflow, version: WorkflowVersion, node: NodeInstance): Cleanup {
    const scoped = this.deps.makeFs(wf);
    const ns = this.#ns(wf.id, node.id);
    const target = this.#resolveStatic(String(node.parameters.path ?? ''), version);
    const emitMode = (node.parameters.emit as string) ?? 'appended';
    const tick = async () => {
      const now = this.deps.clock.now().toISOString();
      try {
        const real = scoped.resolveRead(target);
        let st: fs.Stats | null = null;
        try {
          st = fs.statSync(real);
        } catch {
          st = null;
        }
        const prev = this.deps.store.kv.get(ns, 'file') as { offset: number; size: number; mtime: string } | undefined;
        if (!st) {
          this.#status(wf.id, node.id, { lastCheckAt: now, lastError: `File not found: ${target}` });
          return;
        }
        const cur = { offset: st.size, size: st.size, mtime: st.mtime.toISOString() };
        if (!prev) {
          this.deps.store.kv.set(ns, 'file', cur);
        } else if (prev.size !== st.size || prev.mtime !== cur.mtime) {
          if (emitMode === 'appended') {
            const start = st.size < prev.offset ? 0 : prev.offset;
            const len = Math.min(st.size - start, 5 * 1024 * 1024);
            let text = '';
            if (len > 0) {
              const fd = fs.openSync(real, 'r');
              try {
                const buf = Buffer.alloc(len);
                fs.readSync(fd, buf, 0, len, start);
                text = buf.toString('utf8');
              } finally {
                fs.closeSync(fd);
              }
            }
            if (text.length > 0)
              this.#fire(wf, version, node, [
                { json: { path: real, event: st.size < prev.offset ? 'truncated' : 'appended', appendedText: text, size: st.size, modifiedAt: cur.mtime } },
              ]);
          } else {
            this.#fire(wf, version, node, [{ json: { path: real, event: 'changed', size: st.size, modifiedAt: cur.mtime } }]);
          }
          this.deps.store.kv.set(ns, 'file', cur);
        }
        this.#status(wf.id, node.id, { lastCheckAt: now, lastError: null });
      } catch (e) {
        this.#status(wf.id, node.id, { lastCheckAt: now, lastError: (e as Error).message });
      }
    };
    void tick();
    return this.#every(Math.max(1, Number(node.parameters.pollSeconds ?? 2)) * 1000, tick);
  }

  #armFolderWatch(wf: Workflow, version: WorkflowVersion, node: NodeInstance): Cleanup {
    const scoped = this.deps.makeFs(wf);
    const ns = this.#ns(wf.id, node.id);
    const folder = this.#resolveStatic(String(node.parameters.folder ?? ''), version);
    const recursive = node.parameters.recursive === true;
    const wanted = new Set(Array.isArray(node.parameters.events) && node.parameters.events.length ? (node.parameters.events as string[]) : ['created']);
    const settleMs = Math.max(0, Number(node.parameters.settleSeconds ?? 1)) * 1000;
    const pending = new Map<string, { size: number; modifiedAt: string; since: number }>();
    const tick = async () => {
      const nowDate = this.deps.clock.now();
      try {
        const files = await scoped.list(folder, { recursive, maxEntries: 50_000 });
        const cur = new Map(files.map((f) => [f.path, f]));
        const stored = this.deps.store.kv.get(ns, 'snapshot') as Record<string, { size: number; modifiedAt: string }> | undefined;
        if (!stored) {
          this.deps.store.kv.set(ns, 'snapshot', Object.fromEntries(files.map((f) => [f.path, { size: f.size, modifiedAt: f.modifiedAt }])));
          this.#status(wf.id, node.id, { lastCheckAt: nowDate.toISOString(), lastError: null });
          return;
        }
        const prev = new Map(Object.entries(stored));
        const events: Item[] = [];
        for (const [p, f] of cur) {
          const committed = prev.get(p);
          if (committed && same(committed, f)) {
            pending.delete(p);
            continue;
          }
          const pend = pending.get(p);
          if (settleMs > 0 && (!pend || !same(pend, f))) {
            pending.set(p, { size: f.size, modifiedAt: f.modifiedAt, since: nowDate.getTime() });
            continue;
          }
          if (pend && nowDate.getTime() - pend.since < settleMs) continue;
          events.push({ json: { event: committed ? 'modified' : 'created', ...f, folder } });
          prev.set(p, { size: f.size, modifiedAt: f.modifiedAt });
          pending.delete(p);
        }
        for (const p of [...prev.keys()]) {
          if (!cur.has(p)) {
            events.push({ json: { event: 'deleted', path: p, folder } });
            prev.delete(p);
            pending.delete(p);
          }
        }
        this.deps.store.kv.set(ns, 'snapshot', Object.fromEntries(prev));
        const filtered = events.filter((e) => wanted.has(String(e.json.event)));
        if (filtered.length) this.#fire(wf, version, node, filtered);
        this.#status(wf.id, node.id, { lastCheckAt: nowDate.toISOString(), lastError: null });
      } catch (e) {
        this.#status(wf.id, node.id, { lastCheckAt: nowDate.toISOString(), lastError: (e as Error).message });
      }
    };
    void tick();
    return this.#every(Math.max(1, Number(node.parameters.pollSeconds ?? 2)) * 1000, tick);
  }

  #armHttpPoll(wf: Workflow, version: WorkflowVersion, node: NodeInstance): Cleanup {
    const http = this.deps.makeHttp(wf);
    const ns = this.#ns(wf.id, node.id);
    const tick = async () => {
      const now = this.deps.clock.now().toISOString();
      try {
        const url = this.#resolveStatic(String(node.parameters.url ?? ''), version);
        const res = await http.request({ method: 'GET', url, timeoutMs: 15_000, maxResponseBytes: 2 * 1024 * 1024 });
        const body = res.text();
        const hash = sha256Hex(`${res.status}\n${body}`);
        const last = this.deps.store.kv.get(ns, 'hash') as string | undefined;
        this.deps.store.kv.set(ns, 'hash', hash);
        if (node.parameters.emitWhen === 'always' || (last !== undefined && last !== hash)) {
          this.#fire(wf, version, node, [{ json: { url, status: res.status, body: body.slice(0, 100_000), checkedAt: now, changed: last !== hash } }]);
        }
        this.#status(wf.id, node.id, { lastCheckAt: now, lastError: null });
      } catch (e) {
        this.#status(wf.id, node.id, { lastCheckAt: now, lastError: (e as Error).message });
      }
    };
    void tick();
    return this.#every(Math.max(5, Number(node.parameters.intervalSeconds ?? 300)) * 1000, tick);
  }

  #armRssPoll(wf: Workflow, version: WorkflowVersion, node: NodeInstance): Cleanup {
    const http = this.deps.makeHttp(wf);
    const scope = `rss:${wf.id}:${node.id}`;
    const tick = async () => {
      const now = this.deps.clock.now().toISOString();
      try {
        const url = this.#resolveStatic(String(node.parameters.url ?? ''), version);
        const res = await http.request({ method: 'GET', url, timeoutMs: 20_000, maxResponseBytes: 5 * 1024 * 1024 });
        if (res.status >= 400) throw new Error(`Feed returned HTTP ${res.status}`);
        const fresh = parseFeed(res.text()).filter((e) => !this.deps.store.dedupe.checkAndRecord(scope, e.id));
        if (fresh.length)
          this.#fire(
            wf,
            version,
            node,
            fresh.slice(0, 200).map((e) => ({ json: { ...e, feedUrl: url } })),
          );
        this.#status(wf.id, node.id, { lastCheckAt: now, lastError: null });
      } catch (e) {
        this.#status(wf.id, node.id, { lastCheckAt: now, lastError: (e as Error).message });
      }
    };
    void tick();
    return this.#every(Math.max(30, Number(node.parameters.intervalSeconds ?? 900)) * 1000, tick);
  }

  /** Trigger parameters may reference workflow variables, e.g. {{ $vars.feedUrl }}. */
  #resolveStatic(value: string, version: WorkflowVersion): string {
    if (!value.includes('{{')) return value;
    const now = this.deps.clock.now();
    const out = resolveTemplate(value, {
      roots: { $vars: version.settings.variables, $app: this.deps.app, $now: now.toISOString() },
      fn: { now: () => this.deps.clock.now(), timezone: version.settings.timezone },
    });
    return String(out ?? '');
  }
}
