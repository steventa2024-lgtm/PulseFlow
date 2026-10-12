import { createId, FlowError, isFlowError, toItems, type ExecutionState, type Item, type RetryPolicy, type WorkflowGraph } from "@pulseflow/contracts";
import { redactValue } from "@pulseflow/security";
import { createRegistry, type NodeContext, type NodeRegistry } from "@pulseflow/nodes-core";
import { safeFetch, startDemoServices } from "@pulseflow/connectors";
import type { PulseStore } from "@pulseflow/storage";
import { evaluate, interpolate, parseExpression, type EvalContext } from "./expr";
import { validateGraph } from "./validate";

export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new FlowError("Cancelled", "CANCELLED"));
        return;
      }
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new FlowError("Cancelled", "CANCELLED"));
      });
    }),
};

export interface EnginePaths {
  home: string;
  demo: string;
  inbox: string;
  out: string;
  backup: string;
}

export interface RunOptions {
  payload?: unknown;
  mode?: "production" | "debug" | "demo" | "live";
  triggerType?: string;
  triggerNodeId?: string;
  correlationId?: string;
  replayOf?: string;
  pinMode?: boolean;
  idempotencyKey?: string;
  signal?: AbortSignal;
  depth?: number;
  services?: Record<string, unknown>;
  fixture?: { baseUrl: string; smtpHost?: string; smtpPort?: number; close?: () => Promise<void> };
  resumeCheckpoint?: Checkpoint;
  existingExecutionId?: string;
}

export interface RunResult {
  executionId: string;
  state: ExecutionState;
  error?: string;
  response?: unknown;
  outputs: Record<string, Item[]>;
}

export interface Checkpoint {
  completed: string[];
  taken: Record<string, string[]>;
  outputs: Record<string, Record<string, Item[]>>;
  response?: { status: number; body: unknown; headers?: Record<string, string> };
}

type PortMap = Record<string, Item[]>;

interface RegionOptions {
  graph: WorkflowGraph;
  workflowId: string;
  executionId: string;
  workspaceId: string;
  startId: string;
  seedItems: Item[];
  only?: Set<string>;
  clock: Clock;
  signal: AbortSignal;
  mode: string;
  payload: unknown;
  depth: number;
  pinMode: boolean;
  paths: EnginePaths;
  roots: string[];
  services: Record<string, unknown>;
  retry: RetryPolicy;
  resume?: Checkpoint;
}

export class WorkflowEngine {
  readonly registry: NodeRegistry;
  private readonly controllers = new Map<string, AbortController>();

  constructor(
    private readonly store: PulseStore,
    private readonly paths: EnginePaths,
    private readonly options: {
      registry?: NodeRegistry;
      clock?: Clock;
      key?: Buffer;
      workspaceId?: string;
      allowNetwork?: boolean;
    } = {},
  ) {
    this.registry = options.registry ?? createRegistry();
  }

  cancel(executionId: string): boolean {
    const controller = this.controllers.get(executionId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  async runWorkflow(workflowId: string, options: RunOptions = {}): Promise<RunResult> {
    if (options.idempotencyKey) {
      const existing = this.store.getExecutionByIdempotency(options.idempotencyKey);
      if (existing) {
        return { executionId: existing.id, state: existing.state, outputs: {}, response: existing.response };
      }
    }
    const workflow = this.store.getWorkflow(workflowId);
    if (!workflow) throw new FlowError(`Workflow not found: ${workflowId}`, "NOT_FOUND");
    const validation = validateGraph(workflow.draftGraph, this.registry);
    if (!validation.ok) {
      throw new FlowError(validation.errors.map((issue) => issue.message).join("; "), "INVALID_GRAPH");
    }
    const version = this.store.insertVersion({
      id: createId("ver"),
      workflowId,
      graph: workflow.draftGraph,
      published: false,
      note: "execution snapshot",
    });
    const execution = options.existingExecutionId
      ? this.store.getExecution(options.existingExecutionId)
      : this.store.insertExecution({
          id: createId("exec"),
          workflowId,
          workflowVersionId: version.id,
          triggerType: options.triggerType ?? "manual",
          triggerNodeId: options.triggerNodeId ?? null,
          triggerPayload: options.payload ?? null,
          correlationId: options.correlationId ?? createId("cor"),
          replayOf: options.replayOf ?? null,
          pinMode: options.pinMode ?? false,
          mode: options.mode ?? "production",
          idempotencyKey: options.idempotencyKey ?? null,
        });
    if (!execution) throw new FlowError("Execution was not created", "ENGINE");
    if (options.idempotencyKey) this.store.putIdempotency(options.idempotencyKey, workflowId, execution.id);
    let fixture = options.fixture;
    let closeFixture = options.fixture?.close;
    const wantsFixture =
      (options.mode === "demo" || workflow.draftGraph.meta?.needsFixture === true || workflow.draftGraph.meta?.needsSmtp === true) &&
      options.mode !== "live";
    if (wantsFixture && !fixture) {
      const demo = await startDemoServices();
      fixture = {
        baseUrl: demo.baseUrl,
        smtpHost: demo.smtp.host,
        smtpPort: demo.smtp.port,
      };
      closeFixture = () => demo.close();
    }
    const controller = new AbortController();
    this.controllers.set(execution.id, controller);
    const onAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onAbort);
    if (options.signal?.aborted) controller.abort();
    const clock = this.options.clock ?? systemClock;
    try {
      this.store.addEvent(execution.id, "execution.started", { workflowId, mode: options.mode ?? "production" });
      this.store.updateExecution(execution.id, { state: "running", startedAt: new Date(clock.now()).toISOString(), workflowVersionId: version.id });
      const services: Record<string, unknown> = { mode: options.mode ?? "production", ...(options.services ?? {}) };
      if (fixture) {
        services.fixtureBaseUrl = fixture.baseUrl;
        services.githubApi = `${fixture.baseUrl}/github`;
        services.discordUrl = `${fixture.baseUrl}/discord`;
        services.telegramUrl = `${fixture.baseUrl}/telegram/botdemo/sendMessage`;
        services.ollamaUrl = `${fixture.baseUrl}/api/generate`;
        services.sheetsUrl = `${fixture.baseUrl}/sheets`;
        services.smtpHost = fixture.smtpHost;
        services.smtpPort = fixture.smtpPort;
      }
      const roots = unique([
        ...this.store.listRoots(),
        this.paths.home,
        this.paths.demo,
        this.paths.inbox,
        this.paths.out,
        this.paths.backup,
      ]);
      const startId = options.triggerNodeId ?? selectTrigger(workflow.draftGraph, options.triggerType);
      const region = await this.executeRegion({
        graph: workflow.draftGraph,
        workflowId,
        executionId: execution.id,
        workspaceId: workflow.workspaceId,
        startId,
        seedItems: options.payload === undefined ? [] : toItems(options.payload),
        clock,
        signal: controller.signal,
        mode: options.mode ?? "production",
        payload: options.payload,
        depth: options.depth ?? 0,
        pinMode: options.pinMode ?? options.mode === "debug",
        paths: this.paths,
        roots,
        services,
        retry: workflow.retryPolicy,
        resume: options.resumeCheckpoint,
      });
      if (region.waiting) {
        this.store.updateExecution(execution.id, {
          state: "waiting",
          runAt: new Date(clock.now() + region.waitMs).toISOString(),
          checkpoint: region.checkpoint,
          response: region.response,
        });
        this.store.addEvent(execution.id, "execution.waiting", { waitMs: region.waitMs });
        return { executionId: execution.id, state: "waiting", outputs: region.outputs, response: region.response };
      }
      this.store.updateExecution(execution.id, {
        state: "succeeded",
        endedAt: new Date(clock.now()).toISOString(),
        response: region.response,
        checkpoint: null,
      });
      this.store.addEvent(execution.id, "execution.finished", { state: "succeeded" });
      this.store.audit({
        id: createId("aud"),
        workspaceId: workflow.workspaceId,
        action: "execution.succeeded",
        targetType: "execution",
        targetId: execution.id,
      });
      return { executionId: execution.id, state: "succeeded", outputs: region.outputs, response: region.response };
    } catch (error) {
      const code = isFlowError(error) ? error.code : "FAILED";
      const state: ExecutionState = code === "CANCELLED" ? "cancelled" : code === "TIMEOUT" ? "timed_out" : "failed";
      const message = error instanceof Error ? error.message : "Execution failed";
      this.store.updateExecution(execution.id, {
        state,
        endedAt: new Date(clock.now()).toISOString(),
        errorSummary: message,
        errorCode: code,
      });
      this.store.addEvent(execution.id, "execution.finished", { state, error: message, code });
      return { executionId: execution.id, state, error: message, outputs: {} };
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      this.controllers.delete(execution.id);
      if (closeFixture) await closeFixture();
    }
  }

  private async executeRegion(region: RegionOptions): Promise<{
    outputs: Record<string, Item[]>;
    ports: Record<string, PortMap>;
    response?: { status: number; body: unknown; headers?: Record<string, string> };
    waiting?: boolean;
    waitMs: number;
    checkpoint?: Checkpoint;
  }> {
    const nodes = new Map(region.graph.nodes.map((node) => [node.id, node]));
    const pending = new Set(
      region.only ? [...region.only] : region.graph.nodes.map((node) => node.id),
    );
    if (!region.only) pending.add(region.startId);
    const completed = new Set<string>(region.resume?.completed ?? []);
    const taken = new Map<string, Set<string>>(
      Object.entries(region.resume?.taken ?? {}).map(([id, ports]) => [id, new Set(ports)]),
    );
    const outputs = new Map<string, PortMap>(Object.entries(region.resume?.outputs ?? {}));
    for (const id of completed) pending.delete(id);
    let response = region.resume?.response;
    const workflowTimeout = region.graph.settings?.timeoutMs;
    const started = region.clock.now();
    let guard = 0;
    const limit = region.graph.nodes.length * (region.graph.settings?.maxIterations ?? 100) + 10;

    while (pending.size > 0) {
      guard += 1;
      if (guard > limit) throw new FlowError("Execution exceeded the step limit", "STEP_LIMIT");
      if (region.signal.aborted) throw new FlowError("Cancelled", "CANCELLED");
      if (workflowTimeout && region.clock.now() - started > workflowTimeout) {
        throw new FlowError("Workflow timed out", "TIMEOUT");
      }
      const ready: string[] = [];
      const skipped: string[] = [];
      for (const id of pending) {
        if (isDead(region.graph, id, region.startId, completed, taken, region.only)) skipped.push(id);
        else if (isReady(region.graph, id, region.startId, completed, taken, this.registry, region.only)) ready.push(id);
      }
      if (ready.length === 0 && skipped.length === 0) {
        const waitingOn = [...pending].map((id) => id).join(", ");
        throw new FlowError(`Workflow stalled at ${waitingOn}`, "STALLED");
      }
      for (const id of skipped) {
        pending.delete(id);
        completed.add(id);
        this.recordStep(region, id, 1, "skipped", [], undefined);
        this.store.addEvent(region.executionId, "node.skipped", { nodeId: id });
      }
      for (const id of ready) {
        const node = nodes.get(id);
        if (!node) continue;
        const definition = this.registry.get(node.manifestId);
        if (!definition) throw new FlowError(`Unknown node ${node.manifestId}`, "UNKNOWN_NODE");
        const inputItems = gatherInputs(region.graph, id, region.startId, taken, outputs, region.seedItems, region.only);
        if (node.disabled) {
          const port = definition.manifest.outputs[0]?.id ?? "out";
          pending.delete(id);
          completed.add(id);
          taken.set(id, new Set([port]));
          outputs.set(id, { [port]: inputItems });
          this.recordStep(region, id, 1, "skipped", inputItems, { port, items: inputItems });
          continue;
        }
        if (node.manifestId === "logic.forEach") {
          const loop = await this.executeForEach(region, id, inputItems, outputs);
          pending.delete(id);
          completed.add(id);
          taken.set(id, new Set(["done"]));
          outputs.set(id, { done: loop.items });
          for (const bodyId of loop.body) {
            pending.delete(bodyId);
            completed.add(bodyId);
          }
          continue;
        }
        const outcome = await this.executeNode(region, node, definition.manifest.id, inputItems, outputs, responseSetter);
        if (outcome.waitMs !== undefined) {
          pending.delete(id);
          completed.add(id);
          taken.set(id, new Set([outcome.port]));
          outputs.set(id, outcome.ports);
          return {
            waiting: true,
            waitMs: outcome.waitMs,
            outputs: flattenOutputs(outputs),
            ports: Object.fromEntries(outputs),
            response,
            checkpoint: {
              completed: [...completed],
              taken: Object.fromEntries([...taken].map(([key, value]) => [key, [...value]])),
              outputs: Object.fromEntries(outputs),
              response,
            },
          };
        }
        pending.delete(id);
        completed.add(id);
        taken.set(id, new Set(Object.entries(outcome.ports).filter(([, items]) => items.length > 0).map(([port]) => port)));
        if (taken.get(id)?.size === 0) taken.set(id, new Set([outcome.port]));
        outputs.set(id, outcome.ports);
      }
    }

    function responseSetter(value: { status: number; body: unknown; headers?: Record<string, string> }) {
      response = value;
    }

    return { outputs: flattenOutputs(outputs), ports: Object.fromEntries(outputs), response, waitMs: 0 };
  }

  private async executeForEach(
    region: RegionOptions,
    nodeId: string,
    inputItems: Item[],
    outerOutputs: Map<string, PortMap>,
  ): Promise<{ items: Item[]; body: Set<string> }> {
    const node = region.graph.nodes.find((item) => item.id === nodeId);
    if (!node) throw new FlowError("Loop node disappeared", "ENGINE");
    const cap = Math.min(10_000, Number(node.parameters.maxItems ?? region.graph.settings?.maxIterations ?? 1000));
    const source = typeof node.parameters.expression === "string" && node.parameters.expression.length > 0
      ? this.evaluateExpression(String(node.parameters.expression), inputItems[0] ?? { json: {} }, 0, region, outerOutputs)
      : inputItems.map((item) => item.json);
    const list = Array.isArray(source) ? source : inputItems.map((item) => item.json);
    if (list.length > cap) throw new FlowError(`Loop exceeded the item cap of ${cap}`, "LOOP_CAP");
    const body = collectBody(region.graph, nodeId);
    const collected: Item[] = [];
    for (const entry of list) {
      const item = { json: asRecord(entry) };
      const targets = region.graph.edges.filter((edge) => edge.source === nodeId && edge.sourcePort === "each");
      if (targets.length === 0) {
        collected.push(item);
        continue;
      }
      const startId = targets[0]!.target;
      const nested = await this.executeRegion({
        ...region,
        startId,
        seedItems: [item],
        only: body,
        resume: undefined,
      });
      const returned = iterationItems(region.graph, nodeId, body, nested.ports);
      collected.push(...(returned.length > 0 ? returned : [item]));
    }
    this.recordStep(region, nodeId, 1, "succeeded", inputItems, { items: collected });
    return { items: collected, body };
  }

  private async executeNode(
    region: RegionOptions,
    node: WorkflowGraph["nodes"][number],
    manifestId: string,
    inputItems: Item[],
    outputs: Map<string, PortMap>,
    respond: (value: { status: number; body: unknown; headers?: Record<string, string> }) => void,
  ): Promise<{ items: Item[]; port: string; ports: Record<string, Item[]>; waitMs?: number }> {
    const definition = this.registry.get(manifestId);
    if (!definition) throw new FlowError(`Unknown node ${manifestId}`, "UNKNOWN_NODE");
    if (region.pinMode) {
      const pin = this.store.getPin(region.workflowId, node.id);
      if (pin !== undefined) {
        const items = toItems(pin);
        this.recordStep(region, node.id, 1, "succeeded", inputItems, { pinned: true, items });
        const port = definition.manifest.outputs[0]?.id ?? "out";
        return { items, port, ports: { [port]: items } };
      }
    }
    const policy = node.retry ?? region.retry ?? { maxAttempts: 1, backoffMs: 0, jitter: false };
    const maxAttempts = policy.maxAttempts ?? 1;
    let attempt = 0;
    for (;;) {
      attempt += 1;
      const linked = linkSignal(region.signal, node.timeoutMs ?? 60_000);
      const logs: Array<{ level: "debug" | "info" | "warn" | "error"; message: string; data?: unknown }> = [];
      const startedAt = new Date(region.clock.now()).toISOString();
      this.store.addEvent(region.executionId, "node.started", { nodeId: node.id, attempt });
      try {
        const ctx = this.buildContext(region, node, inputItems, outputs, attempt, linked.signal, logs, respond);
        const result = await definition.execute(ctx);
        linked.dispose();
        const safeItems = redactValue(result.items) as Item[];
        this.recordStep(region, node.id, attempt, "succeeded", redactValue(inputItems), { ...result, items: safeItems }, logs, startedAt);
        this.store.addEvent(region.executionId, "node.finished", { nodeId: node.id, state: "succeeded", attempt });
        return { items: result.items, port: result.port, ports: result.ports, waitMs: result.waitMs };
      } catch (error) {
        linked.dispose();
        const flow = isFlowError(error) ? error : new FlowError(error instanceof Error ? error.message : "Node failed", "NODE");
        if (linked.timedOut() && flow.code !== "CANCELLED") {
          flowMessage(flow, "Node timed out", "TIMEOUT");
        }
        if (region.signal.aborted && flow.code !== "TIMEOUT") flowMessage(flow, "Cancelled", "CANCELLED");
        const retryable = flow.retryable && attempt < maxAttempts && flow.code !== "CANCELLED" && flow.code !== "TIMEOUT";
        this.recordStep(
          region,
          node.id,
          attempt,
          retryable ? "retrying" : flow.code === "CANCELLED" ? "cancelled" : flow.code === "TIMEOUT" ? "timed_out" : "failed",
          redactValue(inputItems),
          undefined,
          logs,
          startedAt,
          flow,
          retryable ? waitFor(policy, attempt, flow.retryAfterMs) : null,
        );
        if (retryable) {
          const wait = waitFor(policy, attempt, flow.retryAfterMs);
          this.store.addEvent(region.executionId, "node.retrying", { nodeId: node.id, attempt, wait });
          await region.clock.sleep(wait, region.signal);
          continue;
        }
        const errorEdge = region.graph.edges.some((edge) => edge.source === node.id && edge.sourcePort === "error");
        if (node.continueOnError || errorEdge) {
          const items = [{ json: { error: flow.message, code: flow.code } }];
          this.store.addEvent(region.executionId, "node.finished", { nodeId: node.id, state: "failed", continued: true });
          return { items, port: "error", ports: { error: items, out: [] } };
        }
        throw flow;
      }
    }
  }

  private buildContext(
    region: RegionOptions,
    node: WorkflowGraph["nodes"][number],
    items: Item[],
    outputs: Map<string, PortMap>,
    attempt: number,
    signal: AbortSignal,
    logs: Array<{ level: "debug" | "info" | "warn" | "error"; message: string; data?: unknown }>,
    respond: (value: { status: number; body: unknown; headers?: Record<string, string> }) => void,
  ): NodeContext {
    const evalContext = (item: Item, index: number): EvalContext => ({
      now: () => region.clock.now(),
      scope: {
        $json: item.json,
        $item: item.json,
        $index: index,
        $now: new Date(region.clock.now()).toISOString(),
        $paths: region.paths,
        $services: region.services,
        $demo: region.paths.demo,
        $fixture: region.services.fixtureBaseUrl,
        $execution: { id: region.executionId, workflowId: region.workflowId, mode: region.mode },
        $node: (id: string) => flattenPortMap(outputs.get(String(id)))[0]?.json ?? null,
      },
    });
    return {
      node,
      items,
      rawParameters: node.parameters,
      execution: {
        id: region.executionId,
        workflowId: region.workflowId,
        workspaceId: region.workspaceId,
        mode: region.mode,
        payload: region.payload,
        depth: region.depth,
      },
      attempt,
      signal,
      clock: region.clock,
      paths: region.paths,
      services: region.services,
      permissions: {
        roots: region.roots,
        allowNetwork: this.options.allowNetwork !== false,
        allowShell: region.graph.settings?.allowShell === true,
        ssrf: {
          allowLoopback: true,
          allowPrivate: region.mode === "live" ? false : true,
        },
      },
      log: (level, message, data) => {
        logs.push({ level, message, data: redactValue(data) as Record<string, unknown> | undefined });
      },
      eval: (expression, item, index) => {
        const inner = unwrap(expression);
        return evaluate(parseExpression(inner), evalContext(item, index));
      },
      interpolate: (value, item, index) => interpolate(value, evalContext(item, index)),
      getOutput: (nodeId) => flattenPortMap(outputs.get(nodeId)),
      kv: {
        get: (namespace, key) => this.store.kvGet(namespace, key),
        set: (namespace, key, value) => this.store.kvSet(namespace, key, value),
      },
      secrets: {
        get: (id) => (this.options.key ? this.store.readCredential(id, this.options.key) : undefined),
      },
      notify: ({ title, body }) => {
        this.store.insertNotification({
          id: createId("note"),
          workspaceId: region.workspaceId,
          executionId: region.executionId,
          title,
          body,
        });
      },
      http: async (request) => {
        const response = await safeFetch({
          url: request.url,
          method: request.method,
          headers: request.headers,
          body: request.body,
          timeoutMs: request.timeoutMs,
          policy: { allowLoopback: true, allowPrivate: region.mode !== "live" },
          signal,
        });
        return response;
      },
      respond,
      runSubworkflow: async (workflowId, childItems, depth) => {
        if (depth > 5) throw new FlowError("Subworkflow recursion limit reached", "RECURSION");
        const child = this.store.getWorkflow(workflowId);
        if (!child) throw new FlowError(`Workflow not found: ${workflowId}`, "NOT_FOUND");
        const childValidation = validateGraph(child.draftGraph, this.registry);
        if (!childValidation.ok) {
          throw new FlowError(childValidation.errors.map((issue) => issue.message).join("; "), "INVALID_GRAPH");
        }
        const result = await this.runWorkflow(workflowId, {
          payload: childItems.map((item) => item.json),
          mode: region.mode as RunOptions["mode"],
          triggerType: "subworkflow",
          depth,
          services: region.services,
          signal: region.signal,
        });
        if (region.signal.aborted || result.state === "cancelled") {
          throw new FlowError(result.error ?? "Cancelled", "CANCELLED");
        }
        if (result.state !== "succeeded") throw new FlowError(result.error ?? "Subworkflow failed", "SUBWORKFLOW");
        const terminal = Object.values(result.outputs).at(-1) ?? [];
        return terminal;
      },
      recordDelivery: (status, detail) => {
        this.store.recordDelivery({ executionId: region.executionId, nodeId: node.id, status, detail });
      },
    };
  }

  private evaluateExpression(
    expression: string,
    item: Item,
    index: number,
    region: RegionOptions,
    outputs: Map<string, PortMap>,
  ): unknown {
    const inner = unwrap(expression);
    return evaluate(parseExpression(inner), {
      now: () => region.clock.now(),
      scope: {
        $json: item.json,
        $index: index,
        $paths: region.paths,
        $services: region.services,
        $node: (id: string) => flattenPortMap(outputs.get(String(id)))[0]?.json ?? null,
      },
    });
  }

  private recordStep(
    region: RegionOptions,
    nodeId: string,
    attempt: number,
    state: string,
    input: unknown,
    output: unknown,
    logs: unknown[] = [],
    startedAt = new Date(region.clock.now()).toISOString(),
    error?: FlowError,
    retryWaitMs?: number | null,
  ): void {
    this.store.insertStep({
      id: createId("step"),
      executionId: region.executionId,
      nodeId,
      attempt,
      state,
      startedAt,
      endedAt: new Date(region.clock.now()).toISOString(),
      input: redactValue(input),
      output: output === undefined ? null : redactValue(output),
      errorCode: error?.code ?? null,
      errorMessage: error ? redactValue(error.message) as string : null,
      errorStack: null,
      retryWaitMs: retryWaitMs ?? null,
      logs,
    });
  }
}

function selectTrigger(graph: WorkflowGraph, triggerType?: string): string {
  const triggers = graph.nodes.filter((node) => node.manifestId.startsWith("trigger."));
  if (triggerType) {
    const match = triggers.find((node) => node.manifestId === `trigger.${triggerType}` || node.manifestId.endsWith(triggerType));
    if (match) return match.id;
  }
  const first = triggers[0];
  if (!first) throw new FlowError("Workflow has no trigger", "MISSING_TRIGGER");
  return first.id;
}

function isReady(
  graph: WorkflowGraph,
  id: string,
  startId: string,
  completed: Set<string>,
  taken: Map<string, Set<string>>,
  registry: NodeRegistry,
  boundary?: Set<string>,
): boolean {
  const edges = internalIncoming(graph, id, boundary);
  if (id === startId && edges.length === 0) return true;
  if (edges.length === 0) return false;
  const node = graph.nodes.find((item) => item.id === id);
  const fanIn = node ? registry.get(node.manifestId)?.manifest.fanIn ?? "all" : "all";
  const live = edges.filter((edge) => completed.has(edge.source) && taken.get(edge.source)?.has(edge.sourcePort));
  if (fanIn === "any") return live.length > 0;
  const settled = edges.every((edge) => completed.has(edge.source));
  return settled && live.length > 0;
}

function isDead(
  graph: WorkflowGraph,
  id: string,
  startId: string,
  completed: Set<string>,
  taken: Map<string, Set<string>>,
  boundary?: Set<string>,
): boolean {
  if (id === startId) return false;
  const edges = internalIncoming(graph, id, boundary);
  if (edges.length === 0) return true;
  return edges.every((edge) => completed.has(edge.source) && !taken.get(edge.source)?.has(edge.sourcePort));
}

function internalIncoming(graph: WorkflowGraph, id: string, boundary?: Set<string>) {
  return incoming(graph, id).filter((edge) => !boundary || boundary.has(edge.source));
}

function incoming(graph: WorkflowGraph, id: string) {
  return graph.edges.filter((edge) => edge.target === id && edge.targetPort !== "loop");
}

function gatherInputs(
  graph: WorkflowGraph,
  id: string,
  startId: string,
  taken: Map<string, Set<string>>,
  outputs: Map<string, PortMap>,
  seed: Item[],
  boundary?: Set<string>,
): Item[] {
  const edges = internalIncoming(graph, id, boundary).filter((edge) => taken.get(edge.source)?.has(edge.sourcePort));
  if (edges.length === 0 && id === startId) return seed;
  const items: Item[] = [];
  for (const edge of edges) items.push(...(outputs.get(edge.source)?.[edge.sourcePort] ?? []));
  return items;
}

function flattenPortMap(map: PortMap | undefined): Item[] {
  return map ? Object.values(map).flat() : [];
}

function flattenOutputs(outputs: Map<string, PortMap>): Record<string, Item[]> {
  return Object.fromEntries([...outputs].map(([id, ports]) => [id, flattenPortMap(ports)]));
}

function collectBody(graph: WorkflowGraph, forEachId: string): Set<string> {
  const body = new Set<string>();
  const queue = graph.edges.filter((edge) => edge.source === forEachId && edge.sourcePort === "each").map((edge) => edge.target);
  while (queue.length > 0) {
    const id = queue.shift();
    if (!id || id === forEachId || body.has(id)) continue;
    body.add(id);
    for (const edge of graph.edges.filter((item) => item.source === id)) {
      if (edge.target !== forEachId) queue.push(edge.target);
    }
  }
  return body;
}

function iterationItems(graph: WorkflowGraph, forEachId: string, body: Set<string>, outputs: Record<string, PortMap>): Item[] {
  const returns = graph.edges.filter((edge) => edge.target === forEachId && edge.targetPort === "loop" && body.has(edge.source));
  if (returns.length > 0) return returns.flatMap((edge) => outputs[edge.source]?.[edge.sourcePort] ?? []);
  const terminals = [...body].filter((id) => !graph.edges.some((edge) => edge.source === id && body.has(edge.target)));
  return terminals.flatMap((id) => flattenPortMap(outputs[id]));
}

function unwrap(expression: string): string {
  const trimmed = expression.trim();
  if (trimmed.startsWith("{{") && trimmed.endsWith("}}")) return trimmed.slice(2, -2);
  return trimmed;
}

function waitFor(policy: RetryPolicy, attempt: number, retryAfter?: number): number {
  if (retryAfter !== undefined) return retryAfter;
  const base = policy.backoffMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(base, policy.maxBackoffMs ?? 30_000);
  if (!policy.jitter) return capped;
  return Math.floor(Math.random() * Math.max(capped, 1));
}

function linkSignal(parent: AbortSignal, timeoutMs: number): { signal: AbortSignal; dispose: () => void; timedOut: () => boolean } {
  const controller = new AbortController();
  let timed = false;
  if (parent.aborted) controller.abort();
  const timer = setTimeout(() => {
    timed = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  parent.addEventListener("abort", onAbort);
  return {
    signal: controller.signal,
    timedOut: () => timed,
    dispose: () => {
      clearTimeout(timer);
      parent.removeEventListener("abort", onAbort);
    },
  };
}

function flowMessage(error: FlowError, message: string, code: string): void {
  error.message = message;
  (error as { code: string }).code = code;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return { value: value as string | number | boolean | null };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function diffGraphs(left: WorkflowGraph, right: WorkflowGraph): {
  nodesAdded: string[];
  nodesRemoved: string[];
  nodesChanged: string[];
  edgesAdded: string[];
  edgesRemoved: string[];
} {
  const leftNodes = new Map(left.nodes.map((node) => [node.id, JSON.stringify(node.parameters)]));
  const rightNodes = new Map(right.nodes.map((node) => [node.id, JSON.stringify(node.parameters)]));
  const leftEdges = new Set(left.edges.map((edge) => edge.id));
  const rightEdges = new Set(right.edges.map((edge) => edge.id));
  return {
    nodesAdded: [...rightNodes.keys()].filter((id) => !leftNodes.has(id)),
    nodesRemoved: [...leftNodes.keys()].filter((id) => !rightNodes.has(id)),
    nodesChanged: [...rightNodes.keys()].filter((id) => leftNodes.has(id) && leftNodes.get(id) !== rightNodes.get(id)),
    edgesAdded: [...rightEdges].filter((id) => !leftEdges.has(id)),
    edgesRemoved: [...leftEdges].filter((id) => !rightEdges.has(id)),
  };
}
