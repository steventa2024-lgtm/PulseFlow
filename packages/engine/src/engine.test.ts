import { chmodSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createId, type GraphEdge, type GraphNode, type WorkflowGraph } from "@pulseflow/contracts";
import { createHarness } from "@pulseflow/testing";
import { nextCronRun, Runtime } from "./runtime";

function chain(count: number): WorkflowGraph {
  const nodes: GraphNode[] = [
    {
      id: "manual",
      manifestId: "trigger.manual",
      manifestVersion: "1.0.0",
      position: { x: 0, y: 0 },
      parameters: { payload: { n: 0 } },
    },
  ];
  const edges: GraphEdge[] = [];
  let previous = "manual";
  for (let index = 1; index <= count; index += 1) {
    const id = `set_${index}`;
    nodes.push({
      id,
      manifestId: "logic.set",
      manifestVersion: "1.0.0",
      position: { x: index * 40, y: 0 },
      parameters: { mode: "merge", fields: [{ name: "n", value: String(index) }] },
    });
    edges.push({ id: `e_${previous}_${id}`, source: previous, sourcePort: "out", target: id, targetPort: "in" });
    previous = id;
  }
  return {
    schemaVersion: 1,
    nodes,
    edges,
    settings: { concurrency: 1, interruptPolicy: "fail", timezone: "UTC" },
  };
}

describe("engine", () => {
  it("cancels a waiting node", async () => {
    const harness = createHarness();
    const workflow = harness.store.getWorkflow("wf_a01");
    if (!workflow) throw new Error("missing workflow");
    harness.store.insertWorkflow({
      id: "wf_cancel",
      workspaceId: workflow.workspaceId,
      name: "Cancel",
      graph: {
        schemaVersion: 1,
        nodes: [
          {
            id: "manual",
            manifestId: "trigger.manual",
            manifestVersion: "1.0.0",
            position: { x: 0, y: 0 },
            parameters: {},
          },
          {
            id: "pause",
            manifestId: "logic.wait",
            manifestVersion: "1.0.0",
            position: { x: 200, y: 0 },
            parameters: { ms: 5_000, durable: false },
          },
        ],
        edges: [{ id: "e_manual_pause", source: "manual", sourcePort: "out", target: "pause", targetPort: "in" }],
        settings: { concurrency: 1, interruptPolicy: "fail", timezone: "UTC" },
      },
    });
    const pending = harness.engine.runWorkflow("wf_cancel");
    let id = "";
    for (let attempt = 0; attempt < 50 && !id; attempt += 1) {
      const running = harness.store.listExecutions({ workflowId: "wf_cancel" })[0];
      if (running) id = running.id;
      else await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(harness.engine.cancel(id)).toBe(true);
    const result = await pending;
    expect(result.state).toBe("cancelled");
    harness.close();
  });

  it("fails interrupted runs on restart and keeps queued work", () => {
    const harness = createHarness();
    const workflow = harness.store.getWorkflow("wf_a01");
    if (!workflow) throw new Error("missing workflow");
    harness.store.insertExecution({
      id: "exec_running",
      workflowId: workflow.id,
      triggerType: "manual",
      triggerPayload: {},
      state: "running",
      correlationId: "cor_running",
    });
    harness.store.insertExecution({
      id: "exec_queued",
      workflowId: workflow.id,
      triggerType: "manual",
      triggerPayload: {},
      state: "queued",
      correlationId: "cor_queued",
    });
    const runtime = new Runtime(harness.store, harness.engine, harness.paths);
    runtime.recover();
    expect(harness.store.getExecution("exec_running")?.state).toBe("failed");
    expect(harness.store.getExecution("exec_running")?.errorCode).toBe("INTERRUPTED");
    expect(harness.store.getExecution("exec_queued")?.state).toBe("queued");
    runtime.stop();
    harness.close();
  });

  it("returns the same execution for an idempotency key", async () => {
    const harness = createHarness();
    const first = await harness.engine.runWorkflow("wf_a01", { idempotencyKey: "same-key" });
    const second = await harness.engine.runWorkflow("wf_a01", { idempotencyKey: "same-key" });
    expect(second.executionId).toBe(first.executionId);
    expect(harness.store.listExecutions({ workflowId: "wf_a01" })).toHaveLength(1);
    harness.close();
  });

  it("uses pinned data only in debug mode", async () => {
    const harness = createHarness();
    harness.store.setPin("pin_set", "wf_a01", "set", { greeting: "pinned", name: "PulseFlow" });
    const debug = await harness.engine.runWorkflow("wf_a01", { mode: "debug" });
    expect(debug.state).toBe("succeeded");
    const pinned = harness.store.listSteps(debug.executionId).find((step) => step.nodeId === "set");
    expect(JSON.stringify(pinned?.output)).toContain("pinned");
    const live = await harness.engine.runWorkflow("wf_a01", { mode: "production" });
    const computed = harness.store.listSteps(live.executionId).find((step) => step.nodeId === "set");
    expect(JSON.stringify(computed?.output)).toContain("Hello, PulseFlow");
    expect(JSON.stringify(computed?.output)).not.toContain("\"greeting\":\"pinned\"");
    harness.close();
  });

  it("rejects writes outside approved roots and into an unwritable folder", async () => {
    const harness = createHarness();
    const workflow = harness.store.getWorkflow("wf_a01");
    if (!workflow) throw new Error("missing workflow");
    harness.store.insertWorkflow({
      id: "wf_escape",
      workspaceId: workflow.workspaceId,
      name: "Escape",
      graph: {
        schemaVersion: 1,
        nodes: [
          {
            id: "manual",
            manifestId: "trigger.manual",
            manifestVersion: "1.0.0",
            position: { x: 0, y: 0 },
            parameters: {},
          },
          {
            id: "write",
            manifestId: "fs.write",
            manifestVersion: "1.0.0",
            position: { x: 200, y: 0 },
            parameters: { path: "/tmp/pulseflow-escape.json", content: "{}", format: "json" },
          },
        ],
        edges: [{ id: "e_manual_write", source: "manual", sourcePort: "out", target: "write", targetPort: "in" }],
        settings: { concurrency: 1, interruptPolicy: "fail", timezone: "UTC" },
      },
    });
    const escaped = await harness.engine.runWorkflow("wf_escape");
    expect(escaped.state).toBe("failed");
    const locked = path.join(harness.paths.demo, "locked");
    mkdirSync(locked, { mode: 0o500 });
    harness.store.insertWorkflow({
      id: "wf_locked",
      workspaceId: workflow.workspaceId,
      name: "Locked",
      graph: {
        schemaVersion: 1,
        nodes: [
          {
            id: "manual",
            manifestId: "trigger.manual",
            manifestVersion: "1.0.0",
            position: { x: 0, y: 0 },
            parameters: {},
          },
          {
            id: "write",
            manifestId: "fs.write",
            manifestVersion: "1.0.0",
            position: { x: 200, y: 0 },
            parameters: { path: path.join(locked, "out.json"), content: "{}", format: "json" },
          },
        ],
        edges: [{ id: "e_manual_write", source: "manual", sourcePort: "out", target: "write", targetPort: "in" }],
        settings: { concurrency: 1, interruptPolicy: "fail", timezone: "UTC" },
      },
    });
    const denied = await harness.engine.runWorkflow("wf_locked");
    expect(denied.state).toBe("failed");
    chmodSync(locked, 0o700);
    rmSync(locked, { recursive: true, force: true });
    harness.close();
  });

  it("schedules 09:00 New York across the DST boundaries", () => {
    const spring = nextCronRun("0 9 * * *", "America/New_York", new Date("2026-03-08T06:30:00.000Z"));
    const autumn = nextCronRun("0 9 * * *", "America/New_York", new Date("2026-11-01T05:30:00.000Z"));
    expect(spring?.toISOString()).toBe("2026-03-08T13:00:00.000Z");
    expect(autumn?.toISOString()).toBe("2026-11-01T14:00:00.000Z");
  });

  it("runs a 100-node chain and lists 1000 execution rows", async () => {
    const harness = createHarness();
    const workflow = harness.store.getWorkflow("wf_a01");
    if (!workflow) throw new Error("missing workflow");
    harness.store.insertWorkflow({
      id: "wf_chain",
      workspaceId: workflow.workspaceId,
      name: "Chain",
      graph: chain(99),
    });
    const started = Date.now();
    const result = await harness.engine.runWorkflow("wf_chain");
    const elapsed = Date.now() - started;
    expect(result.state).toBe("succeeded");
    expect(harness.store.listSteps(result.executionId).filter((step) => step.state === "succeeded").length).toBe(100);
    expect(elapsed).toBeLessThan(15_000);
    for (let index = 0; index < 1000; index += 1) {
      harness.store.insertExecution({
        id: `exec_hist_${index}`,
        workflowId: workflow.id,
        triggerType: "manual",
        triggerPayload: { index },
        state: "succeeded",
        correlationId: createId("cor"),
      });
    }
    const queryStarted = Date.now();
    const page = harness.store.listExecutions({ workflowId: workflow.id, limit: 50 });
    const queryMs = Date.now() - queryStarted;
    expect(page).toHaveLength(50);
    expect(harness.store.countExecutions()).toBeGreaterThanOrEqual(1000);
    expect(queryMs).toBeLessThan(2_000);
    harness.close();
  });

  it("runs a child workflow and returns its output", async () => {
    const harness = createHarness();
    const workspaceId = harness.store.getWorkflow("wf_a01")?.workspaceId;
    if (!workspaceId) throw new Error("missing workspace");
    harness.store.insertWorkflow({
      id: "wf_child",
      workspaceId,
      name: "Child",
      graph: {
        schemaVersion: 1,
        nodes: [
          {
            id: "manual",
            manifestId: "trigger.manual",
            manifestVersion: "1.0.0",
            position: { x: 0, y: 0 },
            parameters: {},
          },
          {
            id: "set",
            manifestId: "logic.set",
            manifestVersion: "1.0.0",
            position: { x: 200, y: 0 },
            parameters: { mode: "merge", fields: [{ name: "greeting", value: "hello-child" }] },
          },
        ],
        edges: [{ id: "e_manual_set", source: "manual", sourcePort: "out", target: "set", targetPort: "in" }],
        settings: { concurrency: 1, interruptPolicy: "fail", timezone: "UTC" },
      },
    });
    harness.store.insertWorkflow({
      id: "wf_parent",
      workspaceId,
      name: "Parent",
      graph: {
        schemaVersion: 1,
        nodes: [
          {
            id: "manual",
            manifestId: "trigger.manual",
            manifestVersion: "1.0.0",
            position: { x: 0, y: 0 },
            parameters: {},
          },
          {
            id: "sub",
            manifestId: "logic.subworkflow",
            manifestVersion: "1.0.0",
            position: { x: 200, y: 0 },
            parameters: { workflowId: "wf_child" },
          },
        ],
        edges: [{ id: "e_manual_sub", source: "manual", sourcePort: "out", target: "sub", targetPort: "in" }],
        settings: { concurrency: 1, interruptPolicy: "fail", timezone: "UTC" },
      },
    });
    const result = await harness.engine.runWorkflow("wf_parent");
    expect(result.state).toBe("succeeded");
    expect(result.outputs.sub?.[0]?.json).toMatchObject({ greeting: "hello-child" });
    harness.close();
  });

  it("stops a workflow that calls itself", async () => {
    const harness = createHarness();
    const workspaceId = harness.store.getWorkflow("wf_a01")?.workspaceId;
    if (!workspaceId) throw new Error("missing workspace");
    harness.store.insertWorkflow({
      id: "wf_loop",
      workspaceId,
      name: "Loop",
      graph: {
        schemaVersion: 1,
        nodes: [
          {
            id: "manual",
            manifestId: "trigger.manual",
            manifestVersion: "1.0.0",
            position: { x: 0, y: 0 },
            parameters: {},
          },
          {
            id: "sub",
            manifestId: "logic.subworkflow",
            manifestVersion: "1.0.0",
            position: { x: 200, y: 0 },
            parameters: { workflowId: "wf_loop" },
          },
        ],
        edges: [{ id: "e_manual_sub", source: "manual", sourcePort: "out", target: "sub", targetPort: "in" }],
        settings: { concurrency: 1, interruptPolicy: "fail", timezone: "UTC" },
      },
    });
    const result = await harness.engine.runWorkflow("wf_loop");
    expect(result.state).toBe("failed");
    expect(result.error).toContain("recursion");
    harness.close();
  });

  it("cancels a running subworkflow when the parent is cancelled", async () => {
    const harness = createHarness();
    const workspaceId = harness.store.getWorkflow("wf_a01")?.workspaceId;
    if (!workspaceId) throw new Error("missing workspace");
    harness.store.insertWorkflow({
      id: "wf_child_wait",
      workspaceId,
      name: "Child wait",
      graph: {
        schemaVersion: 1,
        nodes: [
          {
            id: "manual",
            manifestId: "trigger.manual",
            manifestVersion: "1.0.0",
            position: { x: 0, y: 0 },
            parameters: {},
          },
          {
            id: "pause",
            manifestId: "logic.wait",
            manifestVersion: "1.0.0",
            position: { x: 200, y: 0 },
            parameters: { ms: 5_000, durable: false },
          },
        ],
        edges: [{ id: "e_manual_pause", source: "manual", sourcePort: "out", target: "pause", targetPort: "in" }],
        settings: { concurrency: 1, interruptPolicy: "fail", timezone: "UTC" },
      },
    });
    harness.store.insertWorkflow({
      id: "wf_parent_wait",
      workspaceId,
      name: "Parent wait",
      graph: {
        schemaVersion: 1,
        nodes: [
          {
            id: "manual",
            manifestId: "trigger.manual",
            manifestVersion: "1.0.0",
            position: { x: 0, y: 0 },
            parameters: {},
          },
          {
            id: "sub",
            manifestId: "logic.subworkflow",
            manifestVersion: "1.0.0",
            position: { x: 200, y: 0 },
            parameters: { workflowId: "wf_child_wait" },
          },
        ],
        edges: [{ id: "e_manual_sub", source: "manual", sourcePort: "out", target: "sub", targetPort: "in" }],
        settings: { concurrency: 1, interruptPolicy: "fail", timezone: "UTC" },
      },
    });
    const pending = harness.engine.runWorkflow("wf_parent_wait");
    let parentId = "";
    let childId = "";
    for (let attempt = 0; attempt < 50 && (!parentId || !childId); attempt += 1) {
      const executions = harness.store.listExecutions({ limit: 20 });
      parentId = executions.find((item) => item.workflowId === "wf_parent_wait")?.id ?? "";
      childId = executions.find((item) => item.workflowId === "wf_child_wait")?.id ?? "";
      if (!parentId || !childId) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(parentId).not.toBe("");
    expect(childId).not.toBe("");
    expect(harness.engine.cancel(parentId)).toBe(true);
    const result = await pending;
    expect(result.state).toBe("cancelled");
    expect(harness.store.getExecution(childId)?.state).toBe("cancelled");
    harness.close();
  });
});
