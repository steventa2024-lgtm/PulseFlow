import {
  ENGINE_VERSION,
  TERMINAL_EXECUTION_STATES,
  type EngineEvent,
  type ExecutionError,
  type ExecutionMode,
  type ExecutionState,
  type Item,
  type WorkflowGraph,
  type WorkflowSettings,
} from '@pulseflow/contracts';
import {
  GraphValidationError,
  NodeError,
  WorkflowRuntime,
  type Clock,
  type ExecutionOutcome,
  type ExecutionSink,
  type NodeRegistry,
  type NodeServices,
  type StepUpdate,
} from '@pulseflow/engine';
import { redact, type SecretBox } from '@pulseflow/security';
import type { ExecutionRecord, Store } from '@pulseflow/storage';
import { HttpError } from './credentials';
import type { EventBus } from './events';

export const MAX_STORED_STEP_BYTES = 256 * 1024;
export const MAX_QUEUED_PER_WORKFLOW = 1000;
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface ServiceFactoryInput {
  workflowId: string;
  executionId: string;
  settings: WorkflowSettings;
  secrets: Set<string>;
  depth: number;
}

export interface ExecutionServiceDeps {
  store: Store;
  registry: NodeRegistry;
  clock: Clock;
  bus: EventBus;
  box: SecretBox;
  buildServices: (input: ServiceFactoryInput) => NodeServices;
  maxConcurrent: number;
  globalSecrets: () => string[];
  onFinished?: (rec: ExecutionRecord) => void;
}

export interface EnqueueInput {
  workflowId: string;
  workflowName: string;
  versionId: string | null;
  graph: WorkflowGraph;
  settings: WorkflowSettings;
  triggerNodeId: string;
  items: Item[];
  mode: ExecutionMode;
  pinned?: Record<string, Item[]> | null;
  retryOfExecutionId?: string | null;
  parentExecutionId?: string | null;
  depth?: number;
}

interface RunExtra {
  seed?: Record<string, Record<string, Item[]>>;
  seedNote?: string;
  recordSeeded?: boolean;
  resume?: { nodeId: string; resumeAt: Date };
}

function truncateForStorage(value: unknown): { json: string | null; truncated: boolean } {
  if (value === null || value === undefined) return { json: null, truncated: false };
  const s = JSON.stringify(value);
  if (s.length <= MAX_STORED_STEP_BYTES) return { json: s, truncated: false };
  // Keep a preview of the first items of each port so the inspector stays useful.
  const preview: Record<string, unknown[]> = {};
  for (const [port, items] of Object.entries(value as Record<string, unknown[]>)) {
    preview[port] = [];
    let size = 0;
    for (const it of items) {
      const len = JSON.stringify(it).length;
      if (size + len > MAX_STORED_STEP_BYTES / 4) break;
      preview[port].push(it);
      size += len;
    }
    preview[port].push({ json: { _truncated: `${items.length - preview[port].length} more item(s) not stored (${s.length} bytes total)` } });
  }
  return { json: JSON.stringify(preview), truncated: true };
}

export class ExecutionService {
  readonly #running = new Map<string, { controller: AbortController; workflowId: string }>();
  readonly #perWorkflow = new Map<string, number>();
  readonly #waitTimers = new Map<string, unknown>();
  readonly #waiters = new Map<string, ((rec: ExecutionRecord) => void)[]>();
  #stopped = false;
  #pumping = false;

  constructor(private readonly deps: ExecutionServiceDeps) {}

  get runningCount(): number {
    return this.#running.size;
  }

  #emit(e: EngineEvent): void {
    this.deps.bus.emit(e);
  }

  #emitExecution(rec: Pick<ExecutionRecord, 'id' | 'workflowId'>, state: ExecutionState, error?: ExecutionError | null): void {
    this.#emit({
      type: 'execution.updated',
      executionId: rec.id,
      workflowId: rec.workflowId,
      state,
      ts: this.deps.clock.now().toISOString(),
      error: error ?? null,
    });
  }

  enqueue(input: EnqueueInput): ExecutionRecord {
    const { store } = this.deps;
    if (store.executions.countQueued(input.workflowId) >= MAX_QUEUED_PER_WORKFLOW) {
      store.deadLetters.add({ workflowId: input.workflowId, reason: 'QUEUE_FULL', payload: { triggerNodeId: input.triggerNodeId, items: input.items } });
      throw new HttpError(
        429,
        'QUEUE_FULL',
        `Workflow already has ${MAX_QUEUED_PER_WORKFLOW} queued runs; the trigger payload was moved to the dead-letter queue`,
      );
    }
    const rec = store.executions.create({
      workflowId: input.workflowId,
      workflowName: input.workflowName,
      versionId: input.versionId,
      triggerNodeId: input.triggerNodeId,
      mode: input.mode,
      triggerItems: input.items,
      graph: input.graph,
      settings: input.settings,
      engineVersion: ENGINE_VERSION,
      pinned: input.pinned ?? null,
      retryOfExecutionId: input.retryOfExecutionId ?? null,
      parentExecutionId: input.parentExecutionId ?? null,
      depth: input.depth ?? 0,
    });
    this.#emitExecution(rec, 'queued');
    queueMicrotask(() => this.pump());
    return rec;
  }

  /** Starts queued executions while capacity allows (global + per-workflow limits). */
  pump(): void {
    if (this.#stopped || this.#pumping) return;
    this.#pumping = true;
    try {
      while (this.#running.size < this.deps.maxConcurrent) {
        const rec = this.deps.store.executions.claimNext((wfId) => {
          const wf = this.deps.store.workflows.get(wfId);
          const limit = wf?.settings.maxConcurrentRuns ?? 1;
          return (this.#perWorkflow.get(wfId) ?? 0) < limit;
        });
        if (!rec) break;
        this.#begin(rec);
      }
    } finally {
      this.#pumping = false;
    }
  }

  #begin(rec: ExecutionRecord): void {
    const controller = new AbortController();
    this.#running.set(rec.id, { controller, workflowId: rec.workflowId });
    this.#perWorkflow.set(rec.workflowId, (this.#perWorkflow.get(rec.workflowId) ?? 0) + 1);
    this.#emitExecution(rec, 'running');
    void this.#execute(rec, controller.signal)
      .catch((e: unknown) => {
        this.#finalize(rec, { state: 'failed', error: { code: 'HOST_ERROR', message: (e as Error).message }, outputs: {}, resultItems: [] });
      })
      .finally(() => {
        this.#running.delete(rec.id);
        this.#perWorkflow.set(rec.workflowId, Math.max(0, (this.#perWorkflow.get(rec.workflowId) ?? 1) - 1));
        this.pump();
      });
  }

  #makeSink(rec: ExecutionRecord, secrets: Set<string>): ExecutionSink {
    const { store, bus, box, clock } = this.deps;
    const saveMode = rec.settings.saveExecutionData;
    return {
      step: async (u: StepUpdate) => {
        const scrub = <T>(v: T): T => redact(v, { secrets });
        const input = truncateForStorage(u.input ? scrub(u.input) : null);
        const redactedOut = u.output ? scrub(u.output) : null;
        const output = truncateForStorage(redactedOut);
        const rawJson = u.output ? JSON.stringify(u.output) : null;
        // Exact outputs are kept (encrypted) only when the stored copy differs, for resume/restart.
        const needsRaw = rawJson !== null && (output.truncated || output.json !== rawJson) && rawJson.length < 20 * 1024 * 1024;
        const keepIo = saveMode === 'all' || (saveMode === 'errors' && (u.state === 'failed' || u.state === 'timed_out'));
        store.steps.upsert({
          id: u.stepId,
          executionId: rec.id,
          nodeId: u.nodeId,
          nodeName: u.nodeName,
          nodeType: u.nodeType,
          attempt: u.attempt,
          state: u.state,
          startedAt: u.startedAt,
          finishedAt: u.finishedAt,
          durationMs: u.durationMs,
          input: keepIo && input.json ? (JSON.parse(input.json) as Record<string, Item[]>) : null,
          output: keepIo && output.json ? (JSON.parse(output.json) as Record<string, Item[]>) : null,
          rawOutput: needsRaw || (!keepIo && rawJson) ? `enc:${box.encrypt(rawJson!, rec.id)}` : null,
          error: u.error ? scrub(u.error) : null,
          logs: scrub(u.logs),
          retryInMs: u.retryInMs,
          truncated: input.truncated || output.truncated,
        });
        bus.emit({
          type: 'step.updated',
          executionId: rec.id,
          workflowId: rec.workflowId,
          stepId: u.stepId,
          nodeId: u.nodeId,
          attempt: u.attempt,
          state: u.state,
          ts: clock.now().toISOString(),
          durationMs: u.durationMs,
          retryInMs: u.retryInMs,
          error: u.error ? scrub(u.error) : null,
        });
      },
      log: (nodeId, entry) => {
        bus.emit({
          type: 'step.log',
          executionId: rec.id,
          workflowId: rec.workflowId,
          nodeId,
          level: entry.level,
          message: redact(entry.message, { secrets }),
          ts: entry.ts,
        });
      },
    };
  }

  /** Exact (unredacted) step outputs, for host-internal use such as webhook responses. Never sent to the UI. */
  rawOutputs(executionId: string): Record<string, Record<string, Item[]>> {
    const rec = this.deps.store.executions.get(executionId);
    return rec ? this.deps.store.steps.rawOutputs(rec.id, this.#decode(rec)) : {};
  }

  #decode(rec: ExecutionRecord) {
    return (stored: string) => (stored.startsWith('enc:') ? this.deps.box.decrypt(stored.slice(4), rec.id) : stored);
  }

  async #run(rec: ExecutionRecord, signal: AbortSignal, extra: RunExtra = {}): Promise<ExecutionOutcome> {
    const secrets = new Set(this.deps.globalSecrets());
    const services = this.deps.buildServices({ workflowId: rec.workflowId, executionId: rec.id, settings: rec.settings, secrets, depth: rec.depth });
    const runtime = new WorkflowRuntime({ registry: this.deps.registry, clock: this.deps.clock, services, sink: this.#makeSink(rec, secrets) });
    try {
      return await runtime.run({
        executionId: rec.id,
        workflow: { id: rec.workflowId, name: rec.workflowName, graph: rec.graph, settings: rec.settings },
        triggerNodeId: rec.triggerNodeId,
        triggerItems: rec.triggerItems,
        mode: rec.mode,
        depth: rec.depth,
        signal,
        ...(rec.pinned ? { pinned: rec.pinned } : {}),
        ...extra,
      });
    } catch (e) {
      if (e instanceof GraphValidationError) {
        return { state: 'failed', error: { code: 'WORKFLOW_INVALID', message: e.message }, outputs: {}, resultItems: [] };
      }
      throw e;
    }
  }

  async #execute(rec: ExecutionRecord, signal: AbortSignal): Promise<void> {
    let extra: RunExtra = {};
    if (rec.waitingNodeId && rec.resumeAt) {
      const seed = this.deps.store.steps.rawOutputs(rec.id, this.#decode(rec));
      delete seed[rec.waitingNodeId];
      extra = { seed, recordSeeded: false, resume: { nodeId: rec.waitingNodeId, resumeAt: new Date(rec.resumeAt) } };
      this.deps.store.executions.setState(rec.id, 'running', { resumeAt: null, waitingNodeId: null });
    } else if (rec.retryOfExecutionId && rec.mode === 'retry' && rec.pinned === null) {
      const seedJson = this.deps.store.kv.get('retry-seed', rec.id) as string | undefined;
      if (seedJson) {
        const original = this.deps.store.executions.get(rec.retryOfExecutionId);
        if (original) {
          extra = { seed: this.deps.store.steps.rawOutputs(original.id, this.#decode(original)), seedNote: `Output reused from execution ${original.id}` };
          for (const skip of JSON.parse(seedJson) as string[]) delete extra.seed![skip];
        }
        this.deps.store.kv.delete('retry-seed', rec.id);
      }
    }
    const outcome = await this.#run(rec, signal, extra);
    this.#finalize(rec, outcome);
  }

  #finalize(rec: ExecutionRecord, outcome: ExecutionOutcome): void {
    const { store, clock } = this.deps;
    const now = clock.now().toISOString();
    if (outcome.state === 'waiting' && outcome.waiting) {
      store.executions.setState(rec.id, 'waiting', { resumeAt: outcome.waiting.resumeAt.toISOString(), waitingNodeId: outcome.waiting.nodeId });
      this.#emitExecution(rec, 'waiting');
      this.#scheduleResume(rec.id, outcome.waiting.resumeAt);
      this.#notifyWaiters(rec.id);
      return;
    }
    store.executions.setState(rec.id, outcome.state as ExecutionState, { error: outcome.error, finishedAt: now });
    if (outcome.state === 'failed' && rec.mode === 'trigger') {
      store.deadLetters.add({
        workflowId: rec.workflowId,
        executionId: rec.id,
        reason: outcome.error?.code ?? 'FAILED',
        payload: { triggerNodeId: rec.triggerNodeId, items: rec.triggerItems },
      });
    }
    this.#emitExecution(rec, outcome.state as ExecutionState, outcome.error);
    const final = store.executions.get(rec.id);
    if (final) this.deps.onFinished?.(final);
    this.#notifyWaiters(rec.id);
  }

  #scheduleResume(id: string, at: Date): void {
    const existing = this.#waitTimers.get(id);
    if (existing !== undefined) this.deps.clock.clearTimeout(existing);
    const delay = Math.max(0, at.getTime() - this.deps.clock.now().getTime());
    const handle = this.deps.clock.setTimeout(
      () => {
        this.#waitTimers.delete(id);
        if (delay > MAX_TIMER_MS) return this.#scheduleResume(id, at);
        const rec = this.deps.store.executions.get(id);
        if (rec?.state !== 'waiting') return;
        this.deps.store.executions.setState(id, 'queued');
        this.#emitExecution(rec, 'queued');
        this.pump();
      },
      Math.min(delay, MAX_TIMER_MS),
    );
    this.#waitTimers.set(id, handle);
  }

  #notifyWaiters(id: string): void {
    const rec = this.deps.store.executions.get(id);
    const list = this.#waiters.get(id);
    if (!rec || !list) return;
    this.#waiters.delete(id);
    for (const fn of list) fn(rec);
  }

  /** Resolves once the execution reaches a terminal or waiting state. */
  waitFor(id: string, timeoutMs = 120_000): Promise<ExecutionRecord> {
    const rec = this.deps.store.executions.get(id);
    if (!rec) return Promise.reject(new HttpError(404, 'NOT_FOUND', 'Execution not found'));
    if (TERMINAL_EXECUTION_STATES.includes(rec.state) || rec.state === 'waiting') return Promise.resolve(rec);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new HttpError(504, 'WAIT_TIMEOUT', 'Execution still running')), timeoutMs);
      const list = this.#waiters.get(id) ?? [];
      list.push((r) => {
        clearTimeout(timer);
        resolve(r);
      });
      this.#waiters.set(id, list);
    });
  }

  /** Runs a sub-workflow inline (bypassing the queue so parents cannot deadlock on concurrency). */
  async runChild(input: EnqueueInput, signal?: AbortSignal): Promise<{ record: ExecutionRecord; outcome: ExecutionOutcome }> {
    const rec = this.deps.store.executions.create({
      workflowId: input.workflowId,
      workflowName: input.workflowName,
      versionId: input.versionId,
      triggerNodeId: input.triggerNodeId,
      mode: input.mode,
      triggerItems: input.items,
      graph: input.graph,
      settings: input.settings,
      engineVersion: ENGINE_VERSION,
      parentExecutionId: input.parentExecutionId ?? null,
      depth: input.depth ?? 0,
    });
    this.deps.store.executions.setState(rec.id, 'running', { startedAt: this.deps.clock.now().toISOString() });
    this.#emitExecution(rec, 'running');
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    this.#running.set(rec.id, { controller, workflowId: rec.workflowId });
    try {
      const fresh = this.deps.store.executions.get(rec.id)!;
      const outcome = await this.#run(fresh, controller.signal);
      if (outcome.state === 'waiting') {
        outcome.state = 'failed';
        outcome.error = { code: 'SUBWORKFLOW_WAIT', message: 'Durable waits are not supported inside sub-workflows; use a wait of 5 seconds or less' };
      }
      this.#finalize(fresh, outcome);
      return { record: this.deps.store.executions.get(rec.id)!, outcome };
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.#running.delete(rec.id);
    }
  }

  cancel(id: string, reason = 'Cancelled by user'): ExecutionRecord {
    const rec = this.deps.store.executions.get(id);
    if (!rec) throw new HttpError(404, 'NOT_FOUND', 'Execution not found');
    const running = this.#running.get(id);
    if (running) {
      const err = new Error(reason);
      err.name = 'AbortError';
      running.controller.abort(err);
      return rec;
    }
    if (rec.state === 'queued' || rec.state === 'waiting') {
      const t = this.#waitTimers.get(id);
      if (t !== undefined) this.deps.clock.clearTimeout(t);
      this.#waitTimers.delete(id);
      this.deps.store.executions.setState(id, 'cancelled', { error: { code: 'CANCELLED', message: reason }, finishedAt: this.deps.clock.now().toISOString() });
      this.#emitExecution(rec, 'cancelled');
      this.#notifyWaiters(id);
      return this.deps.store.executions.get(id)!;
    }
    throw new HttpError(409, 'NOT_CANCELLABLE', `Execution is already ${rec.state}`);
  }

  /**
   * Retry from the start (same graph snapshot and trigger payload), or from the failed node:
   * outputs of nodes that succeeded are reused and only failed/unfinished nodes run again.
   */
  retry(id: string, from: 'start' | 'failed'): ExecutionRecord {
    const rec = this.deps.store.executions.get(id);
    if (!rec) throw new HttpError(404, 'NOT_FOUND', 'Execution not found');
    if (!TERMINAL_EXECUTION_STATES.includes(rec.state)) throw new HttpError(409, 'NOT_FINISHED', 'Execution has not finished');
    if (from === 'failed' && rec.state === 'succeeded') throw new HttpError(409, 'NOTHING_TO_RETRY', 'Execution succeeded; use "from start" to replay it');
    const next = this.enqueueRetry(rec, from);
    return next;
  }

  enqueueRetry(rec: ExecutionRecord, from: 'start' | 'failed'): ExecutionRecord {
    const steps = this.deps.store.steps.list(rec.id);
    const failedNodes = [...new Set(steps.filter((s) => s.state !== 'succeeded' && s.state !== 'skipped').map((s) => s.nodeId))];
    const created = this.deps.store.db.transaction(() => {
      const r = this.deps.store.executions.create({
        workflowId: rec.workflowId,
        workflowName: rec.workflowName,
        versionId: rec.versionId,
        triggerNodeId: rec.triggerNodeId,
        mode: 'retry',
        triggerItems: rec.triggerItems,
        graph: rec.graph,
        settings: rec.settings,
        engineVersion: ENGINE_VERSION,
        retryOfExecutionId: rec.id,
        depth: rec.depth,
      });
      if (from === 'failed') this.deps.store.kv.set('retry-seed', r.id, JSON.stringify(failedNodes));
      return r;
    });
    this.#emitExecution(created, 'queued');
    queueMicrotask(() => this.pump());
    return created;
  }

  /**
   * Startup recovery. Interrupted runs are marked failed (code INTERRUPTED) rather than silently
   * re-run, because their side effects may already have happened; users can Retry them.
   */
  recover(): { interrupted: number; resumedWaits: number; queued: number } {
    const { store, clock } = this.deps;
    const interrupted = store.executions.listByState('running');
    for (const rec of interrupted) {
      const error = { code: 'INTERRUPTED', message: 'PulseFlow stopped while this run was in progress. Use Retry to run it again.' };
      store.steps.markInterrupted(rec.id, error);
      store.executions.setState(rec.id, 'failed', { error, finishedAt: clock.now().toISOString() });
    }
    const waits = store.executions.listByState('waiting');
    for (const rec of waits) if (rec.resumeAt) this.#scheduleResume(rec.id, new Date(rec.resumeAt));
    const queued = store.executions.countQueued();
    this.pump();
    return { interrupted: interrupted.length, resumedWaits: waits.length, queued };
  }

  async stop(graceMs = 5000): Promise<void> {
    this.#stopped = true;
    for (const t of this.#waitTimers.values()) this.deps.clock.clearTimeout(t);
    this.#waitTimers.clear();
    const deadline = Date.now() + graceMs;
    while (this.#running.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    for (const r of this.#running.values()) {
      const err = new Error('PulseFlow is shutting down');
      err.name = 'AbortError';
      r.controller.abort(err);
    }
    const hardDeadline = Date.now() + 2000;
    while (this.#running.size > 0 && Date.now() < hardDeadline) await new Promise((r) => setTimeout(r, 25));
  }
}

export function subworkflowError(message: string): NodeError {
  return new NodeError('SUBWORKFLOW_FAILED', message);
}
