import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { scryptSync } from "node:crypto";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import {
  BUNDLE_KIND,
  createId,
  emptyGraph,
  parseBundle,
  parseGraph,
  sanitizeUnknown,
  type WorkflowGraph,
} from "@pulseflow/contracts";
import { diffGraphs, validateGraph } from "@pulseflow/engine";
import {
  decryptJson,
  encryptJson,
  hmacSha256,
  isLoopbackAddress,
  randomToken,
  redactString,
  resolveInside,
  sha256Hex,
  timingSafeStringEqual,
  verifyHmacSha256,
} from "@pulseflow/security";
import { getTemplate, templates, workflowIdFor } from "@pulseflow/templates";
import type { Host } from "./host";

const rawBodies = new WeakMap<FastifyRequest, string>();
const hits = new Map<string, { count: number; reset: number }>();

export interface AppOptions {
  staticDir?: string;
}

export async function buildApp(host: Host, options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 1_048_576, trustProxy: false });
  await app.register(cors, {
    origin: ["http://127.0.0.1:5173", "http://localhost:5173"],
    credentials: true,
  });
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    const text = typeof body === "string" ? body : body.toString("utf8");
    rawBodies.set(request, text);
    if (text.length > 1_000_000) {
      done(new Error("Payload is too large"), undefined);
      return;
    }
    try {
      done(null, text.trim().length === 0 ? {} : sanitizeUnknown(JSON.parse(text)));
    } catch {
      done(new Error("Invalid JSON"), undefined);
    }
  });

  app.addHook("onRequest", async (request, reply) => {
    const remoteAllowed = process.env.PULSEFLOW_ALLOW_REMOTE === "1";
    if (!remoteAllowed && !isLoopbackAddress(request.ip) && request.ip !== "127.0.0.1") {
      return reply.code(403).send({ error: "PulseFlow listens on localhost only" });
    }
    const url = request.url.split("?")[0] ?? "";
    const bucket = url.startsWith("/hooks/") ? "hook" : "api";
    const max = bucket === "hook" ? 60 : 600;
    if (!allow(`${request.ip}:${bucket}`, max)) {
      return reply.code(429).send({ error: "Rate limit exceeded" });
    }
    if (url === "/health" || url.startsWith("/hooks/") || url === "/api/v1/session" || !url.startsWith("/api/")) return;
    if (!authorized(host, request)) {
      return reply.code(401).send({ error: "Authentication required" });
    }
  });

  app.get("/health", async () => ({ ok: true, service: "pulseflow", version: "0.1.0" }));

  app.get("/api/v1/session", async (_request, reply) => {
    reply.header("Set-Cookie", `pf_session=${host.sessionSecret}; HttpOnly; SameSite=Strict; Path=/`);
    return { ok: true, mode: "local", accountRequired: false };
  });

  app.get("/api/v1/openapi.json", async () => openApi());

  app.get("/api/v1/nodes", async () => ({ nodes: host.engine.registry.list() }));

  app.get("/api/v1/templates", async () => ({
    templates: templates.map((template) => ({
      ...template,
      workflowId: workflowIdFor(template.id),
      liveAvailable: template.credentialKind
        ? host.store.listCredentialsByKind(workspaceId(host), template.credentialKind).length > 0
        : !template.graph.meta?.credentialKind,
    })),
  }));

  app.post("/api/v1/templates/:id/instantiate", async (request, reply) => {
    const id = param(request, "id");
    const template = getTemplate(id);
    if (!template) return reply.code(404).send({ error: "Template not found" });
    const existing = host.store.getWorkflow(workflowIdFor(id));
    if (existing) return { workflow: summarize(existing), created: false };
    const identity = host.store.ensureLocalIdentity();
    const workflow = host.store.insertWorkflow({
      id: workflowIdFor(id),
      workspaceId: identity.workspaceId,
      projectId: identity.projectId,
      name: template.name,
      description: template.description,
      tags: [template.tier, template.category, template.id],
      graph: template.graph,
      ownerId: identity.userId,
    });
    return reply.code(201).send({ workflow: summarize(workflow), created: true });
  });

  app.get("/api/v1/workflows", async () => ({
    workflows: host.store.listWorkflows().map(summarize),
  }));

  app.post("/api/v1/workflows", async (request, reply) => {
    const body = record(request.body);
    const name = stringField(body, "name");
    if (!name) return reply.code(400).send({ error: "Name is required" });
    const identity = host.store.ensureLocalIdentity();
    let graph = emptyGraph();
    if (body.graph !== undefined) {
      try {
        graph = parseGraph(body.graph);
      } catch (error) {
        return reply.code(400).send({ error: message(error) });
      }
    }
    const workflow = host.store.insertWorkflow({
      id: createId("wf"),
      workspaceId: identity.workspaceId,
      projectId: identity.projectId,
      name,
      description: stringField(body, "description") ?? "",
      tags: stringArray(body.tags),
      graph,
      timezone: stringField(body, "timezone") ?? "UTC",
      ownerId: identity.userId,
    });
    host.store.audit({ id: createId("aud"), workspaceId: identity.workspaceId, action: "workflow.created", targetId: workflow.id });
    return reply.code(201).send({ workflow });
  });

  app.get("/api/v1/workflows/:id", async (request, reply) => {
    const workflow = host.store.getWorkflow(param(request, "id"));
    if (!workflow) return reply.code(404).send({ error: "Workflow not found" });
    const validation = validateGraph(workflow.draftGraph, host.engine.registry);
    return { workflow, validation };
  });

  app.patch("/api/v1/workflows/:id", async (request, reply) => {
    const id = param(request, "id");
    if (!host.store.getWorkflow(id)) return reply.code(404).send({ error: "Workflow not found" });
    const body = record(request.body);
    let graph: WorkflowGraph | undefined;
    if (body.graph !== undefined) {
      try {
        graph = parseGraph(body.graph);
      } catch (error) {
        return reply.code(400).send({ error: message(error) });
      }
    }
    const workflow = host.store.updateWorkflow(id, {
      name: stringField(body, "name") ?? undefined,
      description: stringField(body, "description") ?? undefined,
      tags: Array.isArray(body.tags) ? stringArray(body.tags) : undefined,
      graph,
      timezone: stringField(body, "timezone") ?? undefined,
    });
    return { workflow, validation: validateGraph(workflow.draftGraph, host.engine.registry) };
  });

  app.post("/api/v1/workflows/:id/validate", async (request, reply) => {
    const workflow = host.store.getWorkflow(param(request, "id"));
    if (!workflow) return reply.code(404).send({ error: "Workflow not found" });
    return validateGraph(workflow.draftGraph, host.engine.registry);
  });

  app.post("/api/v1/workflows/:id/publish", async (request, reply) => activate(host, request, reply));
  app.post("/api/v1/workflows/:id/activate", async (request, reply) => activate(host, request, reply));

  app.post("/api/v1/workflows/:id/deactivate", async (request, reply) => {
    const id = param(request, "id");
    if (!host.store.getWorkflow(id)) return reply.code(404).send({ error: "Workflow not found" });
    host.runtime.deactivate(id);
    return { workflow: host.store.getWorkflow(id) };
  });

  app.post("/api/v1/workflows/:id/run", async (request, reply) => {
    const id = param(request, "id");
    const workflow = host.store.getWorkflow(id);
    if (!workflow) return reply.code(404).send({ error: "Workflow not found" });
    const body = record(request.body);
    const mode = stringField(body, "mode") ?? "production";
    if (mode !== "production" && mode !== "demo" && mode !== "debug" && mode !== "live") {
      return reply.code(400).send({ error: "Unknown run mode" });
    }
    if (mode === "live") {
      const kind = workflow.draftGraph.meta?.credentialKind;
      if (kind && host.store.listCredentialsByKind(workflow.workspaceId, kind).length === 0) {
        return reply.code(409).send({
          error: `Live mode needs a ${kind} credential. Try demo runs the same graph against the local fixture.`,
          code: "CREDENTIAL_REQUIRED",
        });
      }
    }
    const result = await host.engine.runWorkflow(id, {
      payload: body.payload,
      mode,
      pinMode: body.pinMode === true,
      idempotencyKey: stringField(body, "idempotencyKey"),
      triggerType: stringField(body, "triggerType"),
      triggerNodeId: stringField(body, "triggerNodeId"),
      replayOf: stringField(body, "replayOf"),
    });
    const execution = host.store.getExecution(result.executionId);
    return reply.code(result.state === "failed" ? 422 : 200).send({ result, execution, steps: host.store.listSteps(result.executionId) });
  });

  app.post("/api/v1/workflows/:id/nodes/:nodeId/test", async (request, reply) => {
    const id = param(request, "id");
    const nodeId = param(request, "nodeId");
    const workflow = host.store.getWorkflow(id);
    if (!workflow) return reply.code(404).send({ error: "Workflow not found" });
    const node = workflow.draftGraph.nodes.find((item) => item.id === nodeId);
    if (!node) return reply.code(404).send({ error: "Node not found" });
    if (node.manifestId.startsWith("trigger.")) {
      const result = await host.engine.runWorkflow(id, { triggerNodeId: nodeId, mode: "production" });
      return { result, steps: host.store.listSteps(result.executionId) };
    }
    if (host.store.getPin(id, nodeId) === undefined) {
      return reply.code(409).send({
        error: "Pin input for this node before testing it in isolation. Test runs the workflow in debug mode and uses the pin.",
        code: "PIN_REQUIRED",
      });
    }
    const result = await host.engine.runWorkflow(id, { mode: "debug", pinMode: true });
    return { result, steps: host.store.listSteps(result.executionId) };
  });

  app.get("/api/v1/workflows/:id/versions", async (request, reply) => {
    const id = param(request, "id");
    if (!host.store.getWorkflow(id)) return reply.code(404).send({ error: "Workflow not found" });
    return { versions: host.store.listVersions(id) };
  });

  app.get("/api/v1/workflows/:id/versions/:versionId/diff", async (request, reply) => {
    const workflow = host.store.getWorkflow(param(request, "id"));
    const version = host.store.getVersion(param(request, "versionId"));
    if (!workflow || !version || version.workflowId !== workflow.id) return reply.code(404).send({ error: "Version not found" });
    return { diff: diffGraphs(version.graph, workflow.draftGraph) };
  });

  app.post("/api/v1/workflows/:id/restore/:versionId", async (request, reply) => {
    const id = param(request, "id");
    const workflow = host.store.getWorkflow(id);
    const version = host.store.getVersion(param(request, "versionId"));
    if (!workflow || !version || version.workflowId !== id) return reply.code(404).send({ error: "Version not found" });
    if (workflow.active) host.runtime.deactivate(id);
    host.store.updateWorkflow(id, { graph: version.graph });
    const restored = host.store.insertVersion({
      id: createId("ver"),
      workflowId: id,
      graph: version.graph,
      published: false,
      note: `restored ${version.id}`,
    });
    host.store.audit({ id: createId("aud"), workspaceId: workflow.workspaceId, action: "workflow.restored", targetId: id, detail: { versionId: version.id } });
    return { version: restored, workflow: host.store.getWorkflow(id) };
  });

  app.get("/api/v1/executions", async (request) => {
    const query = request.query as { workflowId?: string; state?: string; limit?: string; offset?: string };
    return {
      executions: host.store.listExecutions({
        workflowId: query.workflowId,
        state: query.state,
        limit: numberQuery(query.limit, 50),
        offset: numberQuery(query.offset, 0),
      }),
    };
  });

  app.get("/api/v1/executions/:id", async (request, reply) => {
    const execution = host.store.getExecution(param(request, "id"));
    if (!execution) return reply.code(404).send({ error: "Execution not found" });
    return {
      execution,
      steps: host.store.listSteps(execution.id),
      events: host.store.listEvents(execution.id),
    };
  });

  app.get("/api/v1/executions/:id/events", async (request, reply) => {
    const execution = host.store.getExecution(param(request, "id"));
    if (!execution) return reply.code(404).send({ error: "Execution not found" });
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    let after = 0;
    const terminal = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
    const started = Date.now();
    while (Date.now() - started < 30_000) {
      const events = host.store.listEvents(execution.id, after);
      for (const event of events) {
        after = event.id;
        reply.raw.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
      }
      const current = host.store.getExecution(execution.id);
      if (current && terminal.has(current.state)) {
        reply.raw.write(`event: end\ndata: ${JSON.stringify({ state: current.state })}\n\n`);
        break;
      }
      await delay(200);
      if (reply.raw.destroyed) break;
    }
    reply.raw.end();
  });

  app.post("/api/v1/executions/:id/cancel", async (request, reply) => {
    const id = param(request, "id");
    const execution = host.store.getExecution(id);
    if (!execution) return reply.code(404).send({ error: "Execution not found" });
    const cancelled = host.engine.cancel(id);
    if (!cancelled && (execution.state === "queued" || execution.state === "waiting")) {
      host.store.updateExecution(id, { state: "cancelled", endedAt: new Date().toISOString(), errorCode: "CANCELLED" });
    }
    return { execution: host.store.getExecution(id), cancelled };
  });

  app.post("/api/v1/executions/:id/retry", async (request, reply) => {
    const execution = host.store.getExecution(param(request, "id"));
    if (!execution) return reply.code(404).send({ error: "Execution not found" });
    const result = await host.engine.runWorkflow(execution.workflowId, {
      payload: execution.triggerPayload,
      mode: execution.mode === "live" ? "live" : execution.mode === "demo" ? "demo" : "production",
      replayOf: execution.id,
      triggerType: execution.triggerType,
    });
    return { result, execution: host.store.getExecution(result.executionId) };
  });

  app.get("/api/v1/credentials", async () => ({
    credentials: host.store.listCredentials(workspaceId(host)),
  }));

  app.post("/api/v1/credentials", async (request, reply) => {
    const body = record(request.body);
    const name = stringField(body, "name");
    const kind = stringField(body, "kind");
    if (!name || !kind || body.secret === undefined) return reply.code(400).send({ error: "Name, kind, and secret are required" });
    const meta = host.store.insertCredential({
      id: createId("cred"),
      workspaceId: workspaceId(host),
      name,
      kind,
      secret: body.secret,
      key: host.key,
    });
    host.store.audit({ id: createId("aud"), action: "credential.created", targetId: meta.id, detail: { kind } });
    return reply.code(201).send({ credential: meta });
  });

  app.delete("/api/v1/credentials/:id", async (request, reply) => {
    const id = param(request, "id");
    if (!host.store.getCredentialMeta(id)) return reply.code(404).send({ error: "Credential not found" });
    host.store.deleteCredential(id);
    return { ok: true };
  });

  app.get("/api/v1/schedules", async () => ({ schedules: host.store.listSchedules() }));
  app.get("/api/v1/webhooks", async () => ({
    webhooks: host.store.listWebhooks().map((hook) => ({ ...hook, secretSet: Boolean(hook.secretHash) })),
  }));

  app.post("/hooks/:endpointId", async (request, reply) => {
    const hook = host.store.getWebhook(param(request, "endpointId"));
    if (!hook || !hook.enabled) return reply.code(404).send({ error: "Webhook not found" });
    if (!hook.secret) return reply.code(401).send({ error: "Webhook secret is not configured" });
    const stored = decryptJson(hook.secret, host.key) as { secret?: string };
    const signature = header(request, "x-pulseflow-signature");
    const raw = rawBodies.get(request) ?? "";
    if (!stored.secret || !verifyHmacSha256(stored.secret, raw, signature)) {
      return reply.code(401).send({ error: "Invalid webhook signature" });
    }
    const result = await host.engine.runWorkflow(hook.workflowId, {
      triggerType: "webhook",
      triggerNodeId: hook.nodeId,
      payload: request.body,
    });
    const response = result.response as { status?: number; body?: unknown } | undefined;
    const status = response?.status ?? (result.state === "succeeded" ? 200 : 422);
    return reply.code(status).send(response?.body ?? { ok: result.state === "succeeded", executionId: result.executionId, state: result.state });
  });

  app.get("/api/v1/settings", async () => ({
    telemetry: host.store.getSetting("telemetry", false),
    backgroundExecution: host.store.getSetting("backgroundExecution", false),
    tutorialDismissed: host.store.getSetting("tutorialDismissed", false),
    retentionDays: host.store.getSetting("retentionDays", 30),
    roots: host.store.listRoots(),
  }));

  app.patch("/api/v1/settings", async (request) => {
    const body = record(request.body);
    if (typeof body.telemetry === "boolean") host.store.setSetting("telemetry", body.telemetry);
    if (typeof body.backgroundExecution === "boolean") host.store.setSetting("backgroundExecution", body.backgroundExecution);
    if (typeof body.tutorialDismissed === "boolean") host.store.setSetting("tutorialDismissed", body.tutorialDismissed);
    if (typeof body.retentionDays === "number" && body.retentionDays >= 1 && body.retentionDays <= 3650) {
      host.store.setSetting("retentionDays", Math.floor(body.retentionDays));
    }
    return { ok: true };
  });

  app.post("/api/v1/roots", async (request, reply) => {
    const requested = stringField(record(request.body), "path");
    if (!requested) return reply.code(400).send({ error: "Path is required" });
    const resolved = path.resolve(requested);
    if (resolved === path.parse(resolved).root) return reply.code(400).send({ error: "Refusing to approve a filesystem root" });
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) return reply.code(400).send({ error: "Folder does not exist" });
    host.store.addRoot(createId("root"), resolved, "user");
    host.store.audit({ id: createId("aud"), action: "root.approved", detail: { path: resolved } });
    return { roots: host.store.listRoots() };
  });

  app.get("/api/v1/files", async (request, reply) => {
    const query = request.query as { root?: string; name?: string };
    const root = fileRoot(host, query.root);
    if (!root) return reply.code(400).send({ error: "Unknown file root" });
    if (!query.name) {
      return { files: walkFiles(root).slice(0, 200) };
    }
    let file: string;
    try {
      file = resolveInside([root], path.join(root, query.name));
    } catch (error) {
      return reply.code(400).send({ error: message(error) });
    }
    if (!existsSync(file) || !statSync(file).isFile()) return reply.code(404).send({ error: "File not found" });
    const bytes = statSync(file).size;
    if (bytes > 1_000_000) return reply.code(413).send({ error: "File is too large to preview" });
    return { name: query.name, bytes, text: readFileSync(file, "utf8") };
  });

  app.get("/api/v1/notifications", async () => ({ notifications: host.store.listNotifications() }));
  app.get("/api/v1/audit", async () => ({ events: host.store.listAudit(100) }));

  app.post("/api/v1/pins", async (request, reply) => {
    const body = record(request.body);
    const workflowId = stringField(body, "workflowId");
    const nodeId = stringField(body, "nodeId");
    if (!workflowId || !nodeId) return reply.code(400).send({ error: "workflowId and nodeId are required" });
    host.store.setPin(createId("pin"), workflowId, nodeId, sanitizeUnknown(body.data ?? {}));
    return { ok: true };
  });

  app.get("/api/v1/tokens", async () => ({ tokens: host.store.listTokens() }));

  app.post("/api/v1/tokens", async (request, reply) => {
    const name = stringField(record(request.body), "name") ?? "API token";
    const token = randomToken(32);
    host.store.insertToken({ id: createId("tok"), name, tokenHash: sha256Hex(token), scopes: ["local"] });
    return reply.code(201).send({ token, name, shownOnce: true });
  });

  app.post("/api/v1/import", async (request, reply) => {
    try {
      const bundle = parseBundle(request.body);
      const identity = host.store.ensureLocalIdentity();
      const created = bundle.workflows.map((workflow) =>
        host.store.insertWorkflow({
          id: createId("wf"),
          workspaceId: identity.workspaceId,
          projectId: identity.projectId,
          name: workflow.name,
          description: workflow.description ?? "",
          tags: workflow.tags ?? [],
          graph: workflow.graph,
          timezone: workflow.timezone,
          ownerId: identity.userId,
        }),
      );
      return { workflows: created.map(summarize) };
    } catch (error) {
      return reply.code(400).send({ error: message(error) });
    }
  });

  app.get("/api/v1/workflows/:id/export", async (request, reply) => {
    const workflow = host.store.getWorkflow(param(request, "id"));
    if (!workflow) return reply.code(404).send({ error: "Workflow not found" });
    return {
      schemaVersion: 1,
      kind: BUNDLE_KIND,
      exportedAt: new Date().toISOString(),
      generator: "pulseflow",
      workflows: [
        {
          name: workflow.name,
          description: workflow.description,
          tags: workflow.tags,
          timezone: workflow.timezone,
          graph: workflow.draftGraph,
        },
      ],
    };
  });

  app.post("/api/v1/backup", async (request, reply) => {
    const passphrase = stringField(record(request.body), "passphrase");
    host.store.checkpoint();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    if (!passphrase) {
      const target = path.join(host.paths.backup, `pulseflow-${stamp}.db`);
      writeFileSync(target, readFileSync(host.store.file));
      return { path: target, encrypted: false, keyIncluded: false };
    }
    if (passphrase.length < 8) return reply.code(400).send({ error: "Passphrase must be at least 8 characters" });
    const salt = randomToken(16);
    const key = scryptSync(passphrase, salt, 32);
    const blob = encryptJson({ database: readFileSync(host.store.file).toString("base64") }, key);
    const target = path.join(host.paths.backup, `pulseflow-${stamp}.pfbackup.json`);
    writeFileSync(target, JSON.stringify({ salt, ...blob }), { mode: 0o600 });
    return { path: target, encrypted: true, keyIncluded: false };
  });

  app.post("/api/v1/maintenance/purge", async (request) => {
    const days = host.store.getSetting("retentionDays", 30);
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    return { removed: host.store.purgeExecutionsOlderThan(cutoff), requested: record(request.body) };
  });

  if (options.staticDir) {
    await app.register(fastifyStatic, { root: options.staticDir });
    app.setNotFoundHandler((request, reply) => {
      const url = request.url.split("?")[0] ?? "";
      if (url.startsWith("/api/") || url.startsWith("/hooks/")) return reply.code(404).send({ error: "Not found" });
      return reply.sendFile("index.html");
    });
  }

  return app;
}

async function activate(host: Host, request: FastifyRequest, reply: FastifyReply) {
  const id = param(request, "id");
  if (!host.store.getWorkflow(id)) return reply.code(404).send({ error: "Workflow not found" });
  const revealed: Array<{ id: string; secret: string }> = [];
  try {
    const result = host.runtime.activate(id, {
      mintWebhookSecret: (nodeId) => {
        const secret = randomToken(24);
        revealed.push({ id: `hook_${id}_${nodeId}`, secret });
        return { secretHash: sha256Hex(secret), secret: encryptJson({ secret }, host.key) };
      },
    });
    return {
      versionId: result.versionId,
      workflow: host.store.getWorkflow(id),
      webhooks: revealed,
      note: "Webhook secrets are shown once. Store them now. Signature header: x-pulseflow-signature",
    };
  } catch (error) {
    return reply.code(400).send({ error: message(error) });
  }
}

function authorized(host: Host, request: FastifyRequest): boolean {
  const bearer = header(request, "authorization");
  if (bearer?.startsWith("Bearer ")) {
    return Boolean(host.store.findToken(sha256Hex(bearer.slice(7).trim())));
  }
  const cookie = readCookie(header(request, "cookie"), "pf_session");
  if (!cookie || !timingSafeStringEqual(cookie, host.sessionSecret)) return false;
  if (request.method !== "GET" && request.method !== "HEAD" && header(request, "x-pulseflow-client") !== "studio") return false;
  return true;
}

function allow(key: string, max: number): boolean {
  const now = Date.now();
  const slot = hits.get(key);
  if (!slot || slot.reset < now) {
    hits.set(key, { count: 1, reset: now + 60_000 });
    return true;
  }
  slot.count += 1;
  return slot.count <= max;
}

function workspaceId(host: Host): string {
  return host.store.ensureLocalIdentity().workspaceId;
}

function summarize(workflow: { id: string; name: string; description: string; tags: string[]; active: boolean; updatedAt: string; draftGraph: WorkflowGraph }) {
  return {
    id: workflow.id,
    name: workflow.name,
    description: workflow.description,
    tags: workflow.tags,
    active: workflow.active,
    updatedAt: workflow.updatedAt,
    templateId: workflow.draftGraph.meta?.templateId ?? null,
    tier: workflow.draftGraph.meta?.tier ?? null,
    nodeCount: workflow.draftGraph.nodes.length,
  };
}

function fileRoot(host: Host, name: string | undefined): string | undefined {
  if (name === "demo") return host.paths.demo;
  if (name === "inbox") return host.paths.inbox;
  if (name === "out") return host.paths.out;
  if (name === "backup") return host.paths.backup;
  return undefined;
}

function walkFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string) => {
    if (files.length > 200) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) files.push(path.relative(root, full));
    }
  };
  if (existsSync(root)) visit(root);
  return files;
}

function param(request: FastifyRequest, key: string): string {
  const params = request.params as Record<string, string | undefined>;
  return params[key] ?? "";
}

function header(request: FastifyRequest, key: string): string | undefined {
  const value = request.headers[key];
  return typeof value === "string" ? value : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 30) : [];
}

function numberQuery(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function message(error: unknown): string {
  return redactString(error instanceof Error ? error.message : "Request failed");
}

function readCookie(headerValue: string | undefined, name: string): string | undefined {
  if (!headerValue) return undefined;
  for (const part of headerValue.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openApi() {
  return {
    openapi: "3.0.3",
    info: { title: "PulseFlow Local API", version: "0.1.0" },
    servers: [{ url: "http://127.0.0.1:8787" }],
    paths: {
      "/health": { get: { summary: "Health" } },
      "/api/v1/workflows": { get: { summary: "List workflows" }, post: { summary: "Create workflow" } },
      "/api/v1/workflows/{id}/run": { post: { summary: "Run a workflow" } },
      "/api/v1/executions": { get: { summary: "List executions" } },
      "/hooks/{endpointId}": { post: { summary: "Invoke a signed local webhook" } },
    },
  };
}

export function signatureFor(secret: string, body: string): string {
  return hmacSha256(secret, body);
}
