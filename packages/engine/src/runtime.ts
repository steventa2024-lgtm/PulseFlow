import { watch, type FSWatcher } from "node:fs";
import { Cron } from "croner";
import { createId, FlowError } from "@pulseflow/contracts";
import type { EncryptedBlob } from "@pulseflow/security";
import type { PulseStore } from "@pulseflow/storage";
import { WorkflowEngine, type EnginePaths, type RunOptions } from "./runner";
import { validateGraph } from "./validate";

export function nextCronRun(expression: string, timezone: string, from = new Date()): Date | null {
  const cron = new Cron(expression, { timezone, paused: true });
  const next = cron.nextRun(from);
  cron.stop();
  return next ?? null;
}

export function nextInterval(intervalMs: number, from: Date): Date {
  return new Date(from.getTime() + intervalMs);
}

export class Runtime {
  private timer: NodeJS.Timeout | undefined;
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly startupFired = new Set<string>();
  private ticking = false;

  constructor(
    readonly store: PulseStore,
    readonly engine: WorkflowEngine,
    readonly paths: EnginePaths,
  ) {}

  start(intervalMs = 500): void {
    this.recover();
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }

  recover(): void {
    for (const execution of this.store.listRecoverableExecutions()) {
      const workflow = this.store.getWorkflow(execution.workflowId);
      const policy = workflow?.interruptPolicy ?? "fail";
      if (execution.state === "queued" || execution.state === "waiting") continue;
      if (policy === "requeue") {
        this.store.updateExecution(execution.id, {
          state: "queued",
          runAt: new Date().toISOString(),
          errorSummary: null,
          checkpoint: null,
        });
        this.store.addEvent(execution.id, "execution.requeued", { reason: "restart" });
      } else {
        this.store.updateExecution(execution.id, {
          state: "failed",
          endedAt: new Date().toISOString(),
          errorSummary: "Interrupted by process restart",
          errorCode: "INTERRUPTED",
        });
        this.store.addEvent(execution.id, "execution.finished", { state: "failed", code: "INTERRUPTED" });
      }
    }
  }

  async tick(now = new Date()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const due = this.store.dueSchedules(now.toISOString());
      for (const schedule of due) {
        const next = schedule.kind === "cron" && schedule.cron
          ? nextCronRun(schedule.cron, schedule.timezone, now)
          : nextInterval(schedule.intervalMs ?? 60_000, now);
        this.store.updateSchedule(schedule.id, {
          lastRunAt: now.toISOString(),
          nextRunAt: next?.toISOString() ?? null,
        });
        const missed = schedule.lastRunAt === null && schedule.nextRunAt !== null && Date.parse(schedule.nextRunAt) < now.getTime() - 1000;
        if (missed && schedule.missedPolicy === "skip") continue;
        await this.engine.runWorkflow(schedule.workflowId, {
          triggerType: schedule.kind,
          triggerNodeId: schedule.nodeId,
          payload: { scheduledAt: now.toISOString(), scheduleId: schedule.id },
        });
      }
      const waiting = this.store.listExecutions({ state: "waiting", limit: 20 });
      for (const execution of waiting) {
        if (!execution.runAt || Date.parse(execution.runAt) > now.getTime()) continue;
        const checkpoint = execution.checkpoint as RunOptions["resumeCheckpoint"];
        await this.engine.runWorkflow(execution.workflowId, {
          existingExecutionId: execution.id,
          resumeCheckpoint: checkpoint ?? undefined,
          payload: execution.triggerPayload,
          triggerType: execution.triggerType,
          triggerNodeId: execution.triggerNodeId ?? undefined,
          mode: execution.mode as "production",
        });
      }
    } finally {
      this.ticking = false;
    }
  }

  activate(
    workflowId: string,
    options: { mintWebhookSecret?: (nodeId: string) => { secretHash: string; secret: EncryptedBlob | null } } = {},
  ): { versionId: string; webhooks: Array<{ id: string; nodeId: string }> } {
    const workflow = this.store.getWorkflow(workflowId);
    if (!workflow) throw new FlowError("Workflow not found", "NOT_FOUND");
    const validation = validateGraph(workflow.draftGraph, this.engine.registry);
    if (!validation.ok) {
      throw new FlowError(validation.errors.map((issue) => issue.message).join("; "), "INVALID_GRAPH");
    }
    const version = this.store.insertVersion({
      id: createId("ver"),
      workflowId,
      graph: workflow.draftGraph,
      published: true,
      note: "published",
    });
    const schedules = [];
    const hooks = [];
    for (const node of workflow.draftGraph.nodes) {
      if (node.manifestId === "trigger.schedule") {
        const cron = String(node.parameters.cron ?? "0 9 * * *");
        const timezone = String(node.parameters.timezone ?? workflow.timezone ?? "UTC");
        const next = nextCronRun(cron, timezone, new Date());
        schedules.push({
          id: `sch_${workflowId}_${node.id}`,
          workflowId,
          nodeId: node.id,
          kind: "cron",
          cron,
          intervalMs: null,
          timezone,
          missedPolicy: String(node.parameters.missedPolicy ?? "skip"),
          enabled: true,
          nextRunAt: next?.toISOString() ?? null,
        });
      }
      if (node.manifestId === "trigger.interval") {
        const intervalMs = Number(node.parameters.intervalMs ?? 60_000);
        schedules.push({
          id: `sch_${workflowId}_${node.id}`,
          workflowId,
          nodeId: node.id,
          kind: "interval",
          cron: null,
          intervalMs,
          timezone: workflow.timezone,
          missedPolicy: "skip",
          enabled: true,
          nextRunAt: new Date(Date.now() + intervalMs).toISOString(),
        });
      }
      if (node.manifestId === "trigger.webhook") {
        const minted = options.mintWebhookSecret?.(node.id) ?? { secretHash: null, secret: null };
        hooks.push({
          id: `hook_${workflowId}_${node.id}`,
          nodeId: node.id,
          secretHash: minted.secretHash,
          secret: minted.secret,
          enabled: true,
        });
      }
    }
    this.store.replaceSchedules(workflowId, schedules);
    this.store.replaceWebhooks(workflowId, hooks);
    this.store.updateWorkflow(workflowId, { active: true, currentPublishedVersionId: version.id });
    this.refreshWatchers();
    this.fireStartup(workflow.draftGraph.nodes.filter((node) => node.manifestId === "trigger.appStartup" && node.parameters.enabled === true).map((node) => ({ workflowId, nodeId: node.id })));
    return { versionId: version.id, webhooks: hooks.map((hook) => ({ id: hook.id, nodeId: hook.nodeId })) };
  }

  deactivate(workflowId: string): void {
    this.store.replaceSchedules(workflowId, []);
    this.store.replaceWebhooks(workflowId, []);
    this.store.updateWorkflow(workflowId, { active: false });
    this.refreshWatchers();
  }

  refreshWatchers(): void {
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    for (const workflow of this.store.listWorkflows()) {
      if (!workflow.active) continue;
      for (const node of workflow.draftGraph.nodes) {
        if (node.manifestId !== "trigger.folderChanged" && node.manifestId !== "trigger.fileChanged") continue;
        const target = String(node.parameters.folder ?? node.parameters.file ?? "");
        if (!target || this.watchers.has(`${workflow.id}:${node.id}`)) continue;
        try {
          const watcher = watch(target, { persistent: false }, (_event, filename) => {
            void this.engine.runWorkflow(workflow.id, {
              triggerType: node.manifestId === "trigger.folderChanged" ? "folderChanged" : "fileChanged",
              triggerNodeId: node.id,
              payload: { path: filename ? `${target}/${filename}` : target, event: _event },
            });
          });
          this.watchers.set(`${workflow.id}:${node.id}`, watcher);
        } catch {
          // The folder may not exist until the user creates it. Activation still succeeds.
        }
      }
    }
  }

  private fireStartup(triggers: Array<{ workflowId: string; nodeId: string }>): void {
    for (const trigger of triggers) {
      const key = `${trigger.workflowId}:${trigger.nodeId}`;
      if (this.startupFired.has(key)) continue;
      this.startupFired.add(key);
      void this.engine.runWorkflow(trigger.workflowId, {
        triggerType: "appStartup",
        triggerNodeId: trigger.nodeId,
        payload: { trigger: "startup" },
      });
    }
  }
}
