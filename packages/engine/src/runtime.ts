import {
  DEFAULT_RETRY_POLICY,
  newId,
  type ExecutionError,
  type ExecutionMode,
  type Item,
  type NodeInstance,
  type RetryPolicy,
  type StepLog,
  type StepState,
  type WorkflowGraph,
  type WorkflowSettings,
} from '@pulseflow/contracts';
import { abortError, type Clock } from './clock';
import { classifyError, GraphValidationError, isAbortError, NodeError, toExecutionError, WaitRequest } from './errors';
import { formatDate, resolveDeep, resolveTemplate, type ExpressionScope } from './expressions';
import type { NodeDefinition, NodeExecutionContext, NodeOutput, NodeRegistry, NodeServices } from './types';
import { validateGraph } from './validate';

export const MAX_SUBWORKFLOW_DEPTH = 8;
export const DEFAULT_NODE_TIMEOUT_MS = 5 * 60_000;

export interface StepUpdate {
  stepId: string;
  nodeId: string;
  nodeName: string;
  nodeType: string;
  attempt: number;
  state: StepState;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  input: Record<string, Item[]> | null;
  output: NodeOutput | null;
  error: ExecutionError | null;
  logs: StepLog[];
  retryInMs: number | null;
}

/** Persistence hook. `step` must durably persist before resolving; events are emitted after. */
export interface ExecutionSink {
  step(update: StepUpdate): Promise<void>;
  log(nodeId: string, entry: StepLog): void;
}

export interface RunOptions {
  executionId: string;
  workflow: { id: string; name: string; graph: WorkflowGraph; settings: WorkflowSettings };
  triggerNodeId: string;
  triggerItems: Item[];
  mode: ExecutionMode;
  depth?: number;
  signal?: AbortSignal;
  /** Outputs reused from a previous run (resume after wait, restart from failure). */
  seed?: Record<string, NodeOutput>;
  seedNote?: string;
  /** Whether reused (seeded) nodes get a step record. Off for resumed waits (same execution). */
  recordSeeded?: boolean;
  resume?: { nodeId: string; resumeAt: Date };
  /** Debug-only pinned outputs; ignored for trigger-mode runs. */
  pinned?: Record<string, Item[]>;
}

export type OutcomeState = 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'waiting';

export interface ExecutionOutcome {
  state: OutcomeState;
  error: ExecutionError | null;
  outputs: Record<string, NodeOutput>;
  /** Items emitted by terminal nodes (nodes with no outgoing connections that ran). */
  resultItems: Item[];
  waiting?: { nodeId: string; resumeAt: Date };
}

export interface RuntimeDeps {
  registry: NodeRegistry;
  clock: Clock;
  services: NodeServices;
  sink: ExecutionSink;
  random?: () => number;
}

export function computeBackoff(policy: RetryPolicy, attempt: number, random: () => number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, Math.max(policy.maxDelayMs, retryAfterMs));
  const base = Math.min(policy.maxDelayMs, policy.initialDelayMs * policy.multiplier ** (attempt - 1));
  // "Equal jitter": half fixed, half random — avoids synchronized retry storms.
  return Math.round(policy.jitter ? base / 2 + random() * (base / 2) : base);
}

function countItems(output: NodeOutput): number {
  return Object.values(output).reduce((n, items) => n + items.length, 0);
}

function normalizeOutput(raw: unknown, nodeName: string): NodeOutput {
  if (!raw || typeof raw !== 'object') throw new NodeError('INVALID_OUTPUT', `${nodeName} returned no output`);
  const out: NodeOutput = {};
  for (const [port, items] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(items)) throw new NodeError('INVALID_OUTPUT', `${nodeName} output "${port}" is not a list`);
    out[port] = items.map((it) => {
      const json = (it as Item | undefined)?.json;
      if (!json || typeof json !== 'object' || Array.isArray(json)) {
        throw new NodeError('INVALID_OUTPUT', `${nodeName} produced an item without a JSON object`);
      }
      return { json };
    });
  }
  return out;
}

export class WorkflowRuntime {
  constructor(private readonly deps: RuntimeDeps) {}

  get registry(): NodeRegistry {
    return this.deps.registry;
  }

  async run(opts: RunOptions): Promise<ExecutionOutcome> {
    const { registry, clock, sink } = this.deps;
    const random = this.deps.random ?? Math.random;
    const depth = opts.depth ?? 0;
    if (depth > MAX_SUBWORKFLOW_DEPTH) {
      return this.#fail(`Sub-workflow nesting exceeded ${MAX_SUBWORKFLOW_DEPTH} levels`, 'RECURSION_LIMIT');
    }

    const validation = validateGraph(opts.workflow.graph, registry);
    if (!validation.ok || !validation.compiled) {
      const errors = validation.issues.filter((i) => i.severity === 'error');
      throw new GraphValidationError(errors.map((e) => e.message).join('; '), errors);
    }
    const { graph, order } = validation.compiled;
    const settings = opts.workflow.settings;
    const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
    const trigger = nodes.get(opts.triggerNodeId);
    if (!trigger || !registry.get(trigger.type)?.manifest.trigger) {
      throw new GraphValidationError(`Trigger node ${opts.triggerNodeId} not found`, [{ code: 'NO_TRIGGER', message: 'Trigger not found' }]);
    }

    const outgoing = new Map<string, typeof graph.edges>();
    const incoming = new Map<string, typeof graph.edges>();
    for (const n of graph.nodes) {
      outgoing.set(n.id, []);
      incoming.set(n.id, []);
    }
    for (const e of graph.edges) {
      outgoing.get(e.source)!.push(e);
      incoming.get(e.target)!.push(e);
    }

    // Only nodes downstream of the firing trigger participate in this execution.
    const reachable = new Set<string>();
    const stack = [trigger.id];
    while (stack.length) {
      const id = stack.pop()!;
      if (reachable.has(id)) continue;
      reachable.add(id);
      for (const e of outgoing.get(id) ?? []) stack.push(e.target);
    }
    const orderIndex = new Map(order.map((id, i) => [id, i]));
    const pending = new Set([...reachable].sort((a, b) => orderIndex.get(a)! - orderIndex.get(b)!));
    const done = new Map<string, 'succeeded' | 'skipped' | 'failed'>();
    const outputs: Record<string, NodeOutput> = {};
    const nodeRoot: Record<string, unknown> = {};

    const execController = new AbortController();
    const onParentAbort = () => execController.abort(opts.signal?.reason ?? abortError());
    if (opts.signal?.aborted) onParentAbort();
    opts.signal?.addEventListener('abort', onParentAbort, { once: true });
    const execTimer = clock.setTimeout(() => {
      const err = new Error(`Execution exceeded ${settings.executionTimeoutMs} ms`);
      err.name = 'TimeoutError';
      execController.abort(err);
    }, settings.executionTimeoutMs);

    let fatal: ExecutionError | null = null;
    let waiting: { nodeId: string; resumeAt: Date } | undefined;

    const publishNode = (node: NodeInstance, out: NodeOutput) => {
      outputs[node.id] = out;
      const firstPort = Object.values(out).find((items) => items.length > 0) ?? [];
      const entry = { json: firstPort[0]?.json ?? {}, items: firstPort.map((i) => i.json), outputs: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.map((i) => i.json)])) };
      nodeRoot[node.name] = entry;
      nodeRoot[node.id] = entry;
    };

    const isReady = (id: string) => (incoming.get(id) ?? []).filter((e) => reachable.has(e.source)).every((e) => done.has(e.source));

    const gatherInputs = (id: string): Record<string, Item[]> => {
      const inputs: Record<string, Item[]> = {};
      for (const e of incoming.get(id) ?? []) {
        if (!reachable.has(e.source)) continue;
        const items = outputs[e.source]?.[e.sourcePort] ?? [];
        (inputs[e.targetPort] ??= []).push(...items);
      }
      return inputs;
    };

    const running = new Map<string, Promise<void>>();

    const runNode = async (node: NodeInstance) => {
      const def = registry.get(node.type)!;
      const isTrigger = node.id === trigger.id;
      const inputs = isTrigger ? { main: opts.triggerItems } : gatherInputs(node.id);
      const allItems = Object.values(inputs).flat();
      const stepBase = { nodeId: node.id, nodeName: node.name, nodeType: node.type };

      const seeded = opts.seed?.[node.id];
      const pinned = opts.mode !== 'trigger' ? opts.pinned?.[node.id] : undefined;
      if (seeded || pinned) {
        const out = seeded ?? { [def.manifest.outputs[0]?.name ?? 'main']: pinned! };
        const now = clock.now().toISOString();
        if (seeded && opts.recordSeeded === false) {
          publishNode(node, out);
          done.set(node.id, 'succeeded');
          return;
        }
        await sink.step({
          ...stepBase,
          stepId: newId('stp'),
          attempt: 1,
          state: 'succeeded',
          startedAt: now,
          finishedAt: now,
          durationMs: 0,
          input: inputs,
          output: out,
          error: null,
          logs: [{ ts: now, level: 'info', message: seeded ? (opts.seedNote ?? 'Output reused from previous run') : 'Pinned test data used (node not executed)' }],
          retryInMs: null,
        });
        publishNode(node, out);
        done.set(node.id, 'succeeded');
        return;
      }

      if (!isTrigger && allItems.length === 0) {
        const now = clock.now().toISOString();
        await sink.step({
          ...stepBase,
          stepId: newId('stp'),
          attempt: 1,
          state: 'skipped',
          startedAt: null,
          finishedAt: now,
          durationMs: null,
          input: inputs,
          output: null,
          error: null,
          logs: [{ ts: now, level: 'debug', message: 'Skipped: no items reached this node (branch not taken)' }],
          retryInMs: null,
        });
        publishNode(node, {});
        done.set(node.id, 'skipped');
        return;
      }

      if (node.disabled) {
        const port = def.manifest.outputs[0]?.name ?? 'main';
        const out = { [port]: allItems };
        const now = clock.now().toISOString();
        await sink.step({
          ...stepBase,
          stepId: newId('stp'),
          attempt: 1,
          state: 'skipped',
          startedAt: now,
          finishedAt: now,
          durationMs: 0,
          input: inputs,
          output: out,
          error: null,
          logs: [{ ts: now, level: 'info', message: 'Node disabled: input passed through unchanged' }],
          retryInMs: null,
        });
        publishNode(node, out);
        done.set(node.id, 'skipped');
        return;
      }

      const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...(node.retry ?? {}) };
      const timeoutMs = node.timeoutMs ?? (def.manifest.trigger || node.type === 'core.wait' ? settings.executionTimeoutMs : DEFAULT_NODE_TIMEOUT_MS);

      for (let attempt = 1; ; attempt++) {
        const stepId = newId('stp');
        const startedAtDate = clock.now();
        const logs: StepLog[] = [];
        const log = (level: StepLog['level'], message: string) => {
          const entry = { ts: clock.now().toISOString(), level, message: message.slice(0, 4000) };
          if (logs.length < 500) logs.push(entry);
          sink.log(node.id, entry);
        };
        await sink.step({
          ...stepBase,
          stepId,
          attempt,
          state: 'running',
          startedAt: startedAtDate.toISOString(),
          finishedAt: null,
          durationMs: null,
          input: inputs,
          output: null,
          error: null,
          logs: [],
          retryInMs: null,
        });

        const nodeController = new AbortController();
        const onExecAbort = () => nodeController.abort(execController.signal.reason);
        if (execController.signal.aborted) onExecAbort();
        execController.signal.addEventListener('abort', onExecAbort, { once: true });
        const nodeTimer = clock.setTimeout(() => {
          const err = new NodeError('NODE_TIMEOUT', `${node.name} exceeded its ${timeoutMs} ms timeout`, { retryable: true });
          err.name = 'TimeoutError';
          nodeController.abort(err);
        }, timeoutMs);

        const ctx = this.#makeContext({ opts, node, inputs, items: allItems, attempt, depth, settings, signal: nodeController.signal, log, nodeRoot });
        try {
          const result = await new Promise<NodeOutput>((resolve, reject) => {
            if (nodeController.signal.aborted) return reject(abortError(nodeController.signal));
            const onAbort = () => reject(abortError(nodeController.signal));
            nodeController.signal.addEventListener('abort', onAbort, { once: true });
            def.execute(ctx).then(
              (r) => {
                nodeController.signal.removeEventListener('abort', onAbort);
                resolve(r);
              },
              (e: unknown) => {
                nodeController.signal.removeEventListener('abort', onAbort);
                reject(e);
              },
            );
          });
          const out = normalizeOutput(result, node.name);
          if (countItems(out) > settings.maxItemsPerNode) {
            throw new NodeError('ITEM_LIMIT', `${node.name} produced ${countItems(out)} items (limit ${settings.maxItemsPerNode})`);
          }
          const finished = clock.now();
          await sink.step({
            ...stepBase,
            stepId,
            attempt,
            state: 'succeeded',
            startedAt: startedAtDate.toISOString(),
            finishedAt: finished.toISOString(),
            durationMs: finished.getTime() - startedAtDate.getTime(),
            input: inputs,
            output: out,
            error: null,
            logs,
            retryInMs: null,
          });
          publishNode(node, out);
          done.set(node.id, 'succeeded');
          return;
        } catch (err) {
          const finished = clock.now();
          const base = {
            ...stepBase,
            stepId,
            attempt,
            startedAt: startedAtDate.toISOString(),
            finishedAt: finished.toISOString(),
            durationMs: finished.getTime() - startedAtDate.getTime(),
            input: inputs,
            output: null,
            logs,
          };

          if (err instanceof WaitRequest) {
            await sink.step({ ...base, state: 'waiting', error: null, retryInMs: Math.max(0, err.resumeAt.getTime() - finished.getTime()) });
            waiting ??= { nodeId: node.id, resumeAt: err.resumeAt };
            done.set(node.id, 'succeeded');
            return;
          }

          const execAborted = execController.signal.aborted;
          const nodeTimedOut = !execAborted && nodeController.signal.aborted;
          const execErr = nodeTimedOut
            ? toExecutionError(nodeController.signal.reason, node.id)
            : execAborted
              ? toExecutionError(execController.signal.reason, node.id)
              : toExecutionError(err, node.id);
          if (execAborted) {
            const timedOut = (execController.signal.reason as Error | undefined)?.name === 'TimeoutError';
            await sink.step({ ...base, state: timedOut ? 'timed_out' : 'cancelled', error: execErr, retryInMs: null });
            done.set(node.id, 'failed');
            return;
          }

          const cls = nodeTimedOut ? { retryable: true } : classifyError(err);
          if (cls.retryable && attempt < policy.maxAttempts) {
            const delay = computeBackoff(policy, attempt, random, cls.retryAfterMs);
            log('warn', `Attempt ${attempt} failed (${execErr.message}); retrying in ${delay} ms`);
            await sink.step({ ...base, logs, state: 'retrying', error: execErr, retryInMs: delay });
            try {
              await clock.sleep(delay, execController.signal);
            } catch {
              done.set(node.id, 'failed');
              return;
            }
            continue;
          }

          await sink.step({ ...base, state: nodeTimedOut ? 'timed_out' : 'failed', error: execErr, retryInMs: null });
          const onError = node.onError ?? 'stop';
          const errorItems = (allItems.length ? allItems : [{ json: {} }]).map((it) => ({
            json: { ...it.json, error: { code: execErr.code, message: execErr.message, node: node.name } },
          }));
          if (onError === 'continue') {
            const port = def.manifest.outputs[0]?.name ?? 'main';
            publishNode(node, { [port]: errorItems });
            done.set(node.id, 'failed');
            return;
          }
          if (onError === 'route') {
            publishNode(node, { error: errorItems });
            done.set(node.id, 'failed');
            return;
          }
          fatal ??= execErr;
          done.set(node.id, 'failed');
          execController.abort(Object.assign(new Error(`Stopped: ${node.name} failed`), { name: 'WorkflowFailed' }));
          return;
        } finally {
          clock.clearTimeout(nodeTimer);
          execController.signal.removeEventListener('abort', onExecAbort);
        }
      }
    };

    try {
      while (pending.size > 0 || running.size > 0) {
        if (!execController.signal.aborted && !waiting) {
          for (const id of [...pending]) {
            if (running.size >= settings.maxParallelNodes) break;
            if (!isReady(id)) continue;
            pending.delete(id);
            const p = runNode(nodes.get(id)!).finally(() => running.delete(id));
            running.set(id, p);
          }
        }
        if (running.size === 0) break;
        await Promise.race(running.values());
      }
    } finally {
      clock.clearTimeout(execTimer);
      opts.signal?.removeEventListener('abort', onParentAbort);
    }

    const terminalItems: Item[] = [];
    for (const id of reachable) {
      const hasOut = (outgoing.get(id) ?? []).length > 0;
      if (!hasOut && done.get(id) === 'succeeded') {
        for (const items of Object.values(outputs[id] ?? {})) terminalItems.push(...items);
      }
    }

    if (fatal) return { state: 'failed', error: fatal, outputs, resultItems: terminalItems };
    if (execController.signal.aborted) {
      const reason = execController.signal.reason as Error | undefined;
      const timedOut = reason?.name === 'TimeoutError';
      return {
        state: timedOut ? 'timed_out' : 'cancelled',
        error: { code: timedOut ? 'EXECUTION_TIMEOUT' : 'CANCELLED', message: reason?.message ?? 'Cancelled' },
        outputs,
        resultItems: terminalItems,
      };
    }
    if (waiting) return { state: 'waiting', error: null, outputs, resultItems: terminalItems, waiting };
    return { state: 'succeeded', error: null, outputs, resultItems: terminalItems };
  }

  #fail(message: string, code: string): ExecutionOutcome {
    return { state: 'failed', error: { code, message }, outputs: {}, resultItems: [] };
  }

  #makeContext(args: {
    opts: RunOptions;
    node: NodeInstance;
    inputs: Record<string, Item[]>;
    items: Item[];
    attempt: number;
    depth: number;
    settings: WorkflowSettings;
    signal: AbortSignal;
    log: (level: StepLog['level'], message: string) => void;
    nodeRoot: Record<string, unknown>;
  }): NodeExecutionContext {
    const { opts, node, items, settings } = args;
    const { clock, services, registry } = this.deps;
    const def = registry.get(node.type) as NodeDefinition;
    const tz = settings.timezone;

    const scopeFor = (itemIndex: number, extra?: Record<string, unknown>): ExpressionScope => {
      const item = items[itemIndex] ?? items[0];
      const now = clock.now();
      return {
        roots: {
          $json: item?.json ?? {},
          $item: { index: itemIndex, count: items.length },
          $input: { all: items.map((i) => i.json), first: items[0]?.json ?? null, count: items.length },
          $node: args.nodeRoot,
          $vars: settings.variables,
          $env: services.env,
          $now: now.toISOString(),
          $today: formatDate(now, 'yyyy-MM-dd', tz),
          $execution: { id: opts.executionId, mode: opts.mode, attempt: args.attempt },
          $workflow: { id: opts.workflow.id, name: opts.workflow.name, timezone: tz },
          $trigger: opts.triggerItems[0]?.json ?? {},
          $app: services.app,
          ...(extra ?? {}),
        },
        fn: { now: () => clock.now(), timezone: tz },
      };
    };

    const paramDefault = (name: string) => def.manifest.parameters.find((p) => p.name === name)?.default;

    return {
      executionId: opts.executionId,
      workflowId: opts.workflow.id,
      workflowName: opts.workflow.name,
      node,
      mode: opts.mode,
      attempt: args.attempt,
      depth: args.depth,
      items,
      inputs: args.inputs,
      triggerItems: opts.triggerItems,
      settings,
      signal: args.signal,
      clock,
      services,
      ...(opts.resume && opts.resume.nodeId === node.id ? { resumeAt: opts.resume.resumeAt } : {}),
      rawParam: (name) => node.parameters[name] ?? paramDefault(name),
      param: <T,>(name: string, itemIndex = 0): T => {
        const raw = node.parameters[name] ?? paramDefault(name);
        const pdef = def.manifest.parameters.find((p) => p.name === name);
        if (pdef?.noExpression) return raw as T;
        return resolveDeep(raw, scopeFor(itemIndex)) as T;
      },
      evaluate: (template, itemIndex = 0, extra) => resolveTemplate(template, scopeFor(itemIndex, extra)),
      log: args.log,
    };
  }
}
