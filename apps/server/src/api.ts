import { z } from 'zod';
import {
  CredentialCreateSchema,
  ENGINE_VERSION,
  PermissionGrantsSchema,
  RunRequestSchema,
  TERMINAL_EXECUTION_STATES,
  WorkflowCreateSchema,
  WorkflowGraphSchema,
  WorkflowPatchSchema,
  type AppInfo,
  type EngineEvent,
  type ExecutionState,
  type NodeCatalogEntry,
} from '@pulseflow/contracts';
import { CREDENTIAL_TYPES } from '@pulseflow/connectors';
import { redact } from '@pulseflow/security';
import { PLANNED_TEMPLATES, TEMPLATES, getTemplate, summarize } from '@pulseflow/templates';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireRole } from './auth';
import { HttpError } from './credentials';
import { DLQ_REPLAY_NS } from './executions';
import type { HostContext } from './host';

function body<T extends z.ZodTypeAny>(schema: T, req: FastifyRequest): z.infer<T> {
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) throw new HttpError(400, 'INVALID_REQUEST', 'Request body is invalid', parsed.error.issues.slice(0, 20));
  return parsed.data;
}

const IdParams = z.object({ id: z.string().min(1).max(100) });
const ExecutionQuerySchema = z.object({
  workflowId: z.string().max(100).optional(),
  state: z.string().max(200).optional(),
  search: z.string().max(200).optional(),
  before: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});
const SettingsPatchSchema = z.object({
  advancedNodes: z.boolean().optional(),
  envAllowList: z
    .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/))
    .max(100)
    .optional(),
  retentionDays: z.number().int().min(1).max(3650).optional(),
  keepRunningInTray: z.boolean().optional(),
});
export type AppSettings = Required<z.infer<typeof SettingsPatchSchema>>;
export const DEFAULT_APP_SETTINGS: AppSettings = { advancedNodes: false, envAllowList: [], retentionDays: 30, keepRunningInTray: true };

export function readAppSettings(ctx: Pick<HostContext, 'store'>): AppSettings {
  return { ...DEFAULT_APP_SETTINGS, ...ctx.store.settings.get<Partial<AppSettings>>('app', {}) };
}

export function registerApi(app: FastifyInstance, ctx: HostContext): void {
  const actor = (req: FastifyRequest) => req.principal?.userId ?? 'system';
  const params = (req: FastifyRequest) => IdParams.parse(req.params);

  app.get('/api/health', async () => ({ ok: true, version: ctx.config.appVersion, engineVersion: ENGINE_VERSION }));

  app.get('/api/app/info', async (): Promise<AppInfo & { needsSetup: boolean; fixtures: boolean }> => ({
    name: 'PulseFlow',
    version: ctx.config.appVersion,
    engineVersion: ENGINE_VERSION,
    mode: ctx.config.mode,
    dataDir: ctx.config.dataDir,
    demoDir: ctx.config.demoDir,
    fixturesUrl: ctx.fixturesUrl(),
    platform: process.platform,
    telemetry: false,
    needsSetup: ctx.auth.needsSetup(),
    fixtures: ctx.config.fixtures,
  }));

  // ---- auth (server mode) ----
  const Login = z.object({ email: z.string().email().max(320), password: z.string().min(1).max(1000) });
  const Setup = Login.extend({ name: z.string().min(1).max(200), password: z.string().min(10).max(1000) });
  app.post('/api/auth/setup', async (req) => {
    const b = body(Setup, req);
    const { token, user } = ctx.auth.setup(b);
    ctx.store.audit.record(user.id, 'auth.setup', user.id);
    return { token, user: { id: user.id, email: user.email, name: user.name, role: user.role } };
  });
  app.post('/api/auth/login', async (req) => {
    const b = body(Login, req);
    const { token, user } = ctx.auth.login(b.email, b.password);
    ctx.store.audit.record(user.id, 'auth.login', user.id);
    return { token, user: { id: user.id, email: user.email, name: user.name, role: user.role } };
  });
  app.post('/api/auth/logout', async (req) => {
    ctx.auth.logout(req);
    return { ok: true };
  });
  app.get('/api/auth/me', async (req) => req.principal);
  app.get('/api/users', async (req) => {
    requireRole(req, 'admin');
    return ctx.store.users.list().map((u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, disabled: u.disabled === 1, createdAt: u.created_at }));
  });
  app.post('/api/users', async (req) => {
    requireRole(req, 'admin');
    if (ctx.config.mode !== 'server') throw new HttpError(400, 'LOCAL_MODE', 'User accounts are only used in server mode');
    const b = body(Setup.extend({ role: z.enum(['admin', 'editor', 'viewer']) }), req);
    const u = ctx.auth.createUser(b);
    ctx.store.audit.record(actor(req), 'user.create', u.id, { role: u.role });
    return { id: u.id, email: u.email, name: u.name, role: u.role };
  });
  app.post('/api/tokens', async (req) => {
    const p = requireRole(req, 'editor');
    if (ctx.config.mode !== 'server') throw new HttpError(400, 'LOCAL_MODE', 'API tokens are only used in server mode');
    const b = body(z.object({ name: z.string().min(1).max(100) }), req);
    const t = ctx.auth.createApiToken(p.userId, b.name);
    ctx.store.audit.record(p.userId, 'token.create', t.id, { name: b.name });
    return t;
  });

  // ---- catalog ----
  app.get('/api/nodes', async (): Promise<NodeCatalogEntry[]> => {
    const settings = readAppSettings(ctx);
    return ctx.registry.manifests().map((m) => {
      const advancedOff = m.risk === 'advanced' && !settings.advancedNodes;
      return {
        ...m,
        enabled: !advancedOff,
        ...(advancedOff ? { disabledReason: 'Advanced nodes are disabled. Enable them in Settings → Advanced and grant the workflow permission.' } : {}),
      };
    });
  });
  app.get('/api/credential-types', async () => CREDENTIAL_TYPES);

  // ---- credentials (metadata only; secrets are write-only) ----
  app.get('/api/credentials', async () => ctx.credentials.list());
  app.get('/api/credentials/:id', async (req) => {
    const c = ctx.credentials.get(params(req).id);
    if (!c) throw new HttpError(404, 'NOT_FOUND', 'Credential not found');
    return c;
  });
  app.post('/api/credentials', async (req) => {
    requireRole(req, 'admin');
    const b = body(CredentialCreateSchema, req);
    const c = ctx.credentials.create(b);
    ctx.store.audit.record(actor(req), 'credential.create', c.id, { type: c.type, name: c.name });
    return c;
  });
  app.patch('/api/credentials/:id', async (req) => {
    requireRole(req, 'admin');
    const b = body(z.object({ name: z.string().min(1).max(200).optional(), data: z.record(z.string(), z.string().max(20_000)).optional() }), req);
    const c = ctx.credentials.update(params(req).id, b);
    ctx.store.audit.record(actor(req), 'credential.update', c.id, { fields: Object.keys(b.data ?? {}) });
    return c;
  });
  app.delete('/api/credentials/:id', async (req) => {
    requireRole(req, 'admin');
    const id = params(req).id;
    if (!ctx.credentials.delete(id)) throw new HttpError(404, 'NOT_FOUND', 'Credential not found');
    ctx.store.audit.record(actor(req), 'credential.delete', id);
    return { ok: true };
  });

  // ---- workflows ----
  app.get('/api/workflows', async (req) => {
    const q = z.object({ search: z.string().max(200).optional(), active: z.enum(['true', 'false']).optional() }).parse(req.query);
    const list = ctx.workflows.list({ ...(q.search ? { search: q.search } : {}), ...(q.active ? { active: q.active === 'true' } : {}) });
    const stats = new Map(list.map((w) => [w.id, ctx.store.executions.list({ workflowId: w.id, limit: 1 })[0] ?? null]));
    return list.map((w) => ({ ...w, draft: undefined, nodeCount: w.draft.nodes.length, lastExecution: stats.get(w.id) }));
  });
  app.post('/api/workflows', async (req) => ctx.workflows.create(body(WorkflowCreateSchema, req), actor(req)));
  app.get('/api/workflows/:id', async (req) => ctx.workflows.get(params(req).id));
  app.patch('/api/workflows/:id', async (req) => ctx.workflows.update(params(req).id, body(WorkflowPatchSchema, req), actor(req)));
  app.delete('/api/workflows/:id', async (req) => {
    ctx.workflows.delete(params(req).id, actor(req));
    return { ok: true };
  });
  app.post('/api/workflows/:id/duplicate', async (req) => ctx.workflows.duplicate(params(req).id, actor(req)));
  app.post('/api/workflows/:id/validate', async (req) => {
    const b = body(z.object({ graph: WorkflowGraphSchema.optional() }), req);
    return ctx.workflows.validate(b.graph ?? ctx.workflows.get(params(req).id).draft);
  });
  app.post('/api/validate', async (req) => ctx.workflows.validate(body(z.object({ graph: WorkflowGraphSchema }), req).graph));
  app.post('/api/workflows/:id/publish', async (req) =>
    ctx.workflows.publish(params(req).id, body(z.object({ note: z.string().max(500).default('') }), req).note, actor(req)),
  );
  app.post('/api/workflows/:id/activate', async (req) => ctx.workflows.activate(params(req).id, actor(req)));
  app.post('/api/workflows/:id/deactivate', async (req) => ctx.workflows.deactivate(params(req).id, actor(req)));
  app.get('/api/workflows/:id/versions', async (req) => ctx.workflows.versions(params(req).id));
  app.get('/api/workflows/:id/versions/:versionId', async (req) => {
    const p = z.object({ id: z.string(), versionId: z.string() }).parse(req.params);
    return ctx.workflows.version(p.id, p.versionId);
  });
  app.post('/api/workflows/:id/versions/:versionId/restore', async (req) => {
    const p = z.object({ id: z.string(), versionId: z.string() }).parse(req.params);
    return ctx.workflows.restore(p.id, p.versionId, actor(req));
  });
  app.put('/api/workflows/:id/permissions', async (req) => {
    requireRole(req, 'editor');
    return ctx.workflows.setPermissions(params(req).id, body(PermissionGrantsSchema, req), actor(req));
  });
  app.get('/api/workflows/:id/triggers', async (req) => {
    const id = params(req).id;
    ctx.workflows.get(id);
    const base = ctx.publicBaseUrl();
    return ctx.triggers.statuses(id).map((s) => ({ ...s, ...(s.webhookPath ? { webhookUrl: `${base}${s.webhookPath}` } : {}) }));
  });
  app.post('/api/workflows/:id/webhooks/:nodeId/rotate', async (req) => {
    const p = z.object({ id: z.string(), nodeId: z.string() }).parse(req.params);
    ctx.workflows.get(p.id);
    ctx.rotateWebhook(p.id, p.nodeId);
    ctx.store.audit.record(actor(req), 'webhook.rotate', p.id, { nodeId: p.nodeId });
    return { ok: true };
  });
  app.post('/api/workflows/:id/run', async (req) => {
    const b = body(RunRequestSchema, req);
    const rec = ctx.workflows.run(params(req).id, b, actor(req));
    if (!b.wait) return { executionId: rec.id, state: rec.state };
    const done = await ctx.executions.waitFor(rec.id, 120_000);
    return { executionId: done.id, state: done.state, error: done.error };
  });

  // ---- executions ----
  app.get('/api/executions', async (req) => {
    const q = ExecutionQuerySchema.parse(req.query);
    return ctx.store.executions.list({
      ...(q.workflowId ? { workflowId: q.workflowId } : {}),
      ...(q.state ? { states: q.state.split(',') as ExecutionState[] } : {}),
      ...(q.search ? { search: q.search } : {}),
      ...(q.before ? { before: q.before } : {}),
      limit: q.limit,
    });
  });
  app.get('/api/executions/stats', async (req) => {
    const q = z.object({ workflowId: z.string().optional() }).parse(req.query);
    return ctx.store.executions.stats(q.workflowId);
  });
  app.get('/api/executions/:id', async (req) => {
    const rec = ctx.store.executions.get(params(req).id);
    if (!rec) throw new HttpError(404, 'NOT_FOUND', 'Execution not found');
    const secrets = ctx.credentials.allSecretValues();
    const { graph, settings, triggerItems, pinned, ...meta } = rec;
    return { ...meta, ...redact({ graph, settings, triggerItems, pinned }, { secrets }), steps: ctx.store.steps.list(rec.id) };
  });
  app.post('/api/executions/:id/cancel', async (req) => ctx.executions.cancel(params(req).id, `Cancelled by ${req.principal?.name ?? 'user'}`));
  app.post('/api/executions/:id/retry', async (req) => {
    const b = body(z.object({ from: z.enum(['start', 'failed']).default('failed') }), req);
    const rec = ctx.executions.retry(params(req).id, b.from);
    ctx.store.audit.record(actor(req), 'execution.retry', params(req).id, { from: b.from, newExecutionId: rec.id });
    return { executionId: rec.id, state: rec.state };
  });
  app.post('/api/executions/:id/wait', async (req) => {
    const rec = await ctx.executions.waitFor(params(req).id, 60_000);
    return { executionId: rec.id, state: rec.state, error: rec.error, terminal: TERMINAL_EXECUTION_STATES.includes(rec.state) };
  });

  // ---- templates ----
  app.get('/api/templates', async () => ({ templates: TEMPLATES.map(summarize), planned: PLANNED_TEMPLATES }));
  app.get('/api/templates/:id', async (req) => {
    const t = getTemplate(params(req).id);
    if (!t) throw new HttpError(404, 'NOT_FOUND', 'Template not found');
    return { ...t, fixtures: Object.keys(t.fixtures) };
  });
  app.post('/api/templates/:id/instantiate', async (req) => {
    const b = body(
      z.object({
        demo: z.boolean().default(false),
        name: z.string().min(1).max(200).optional(),
        variables: z.record(z.string(), z.union([z.string().max(10_000), z.number(), z.boolean()])).optional(),
      }),
      req,
    );
    const { workflow, templateDir } = ctx.workflows.instantiateTemplate(
      params(req).id,
      { demo: b.demo, ...(b.name ? { name: b.name } : {}), ...(b.variables ? { variables: b.variables } : {}) },
      actor(req),
    );
    return { workflow, templateDir };
  });

  // ---- import / export ----
  app.post('/api/export', async (req) => ctx.workflows.exportBundle(body(z.object({ ids: z.array(z.string()).min(1).max(1000) }), req).ids));
  app.post('/api/import', async (req) => ctx.workflows.importBundle(req.body, actor(req)));

  // ---- notifications, DLQ, audit, settings, backup ----
  app.get('/api/notifications', async () => ctx.store.notifications.list(100));
  app.post('/api/notifications/read', async () => {
    ctx.store.notifications.markAllRead();
    return { ok: true };
  });
  app.get('/api/dead-letters', async () => ctx.store.deadLetters.list(200));
  app.delete('/api/dead-letters/:id', async (req) => {
    ctx.store.deadLetters.delete(params(req).id);
    return { ok: true };
  });
  app.post('/api/dead-letters/:id/replay', async (req) => {
    const entry = ctx.store.deadLetters.list(10_000).find((d) => d.id === params(req).id);
    if (!entry) throw new HttpError(404, 'NOT_FOUND', 'Dead letter not found');
    const payload = entry.payload as { triggerNodeId?: string; items?: { json: Record<string, unknown> }[] };
    // Remove first so a second click cannot start two replays. The run puts the payload back if it fails.
    ctx.store.deadLetters.delete(entry.id);
    let rec;
    try {
      rec = ctx.workflows.run(
        entry.workflow_id,
        { useDraft: false, wait: false, ...(payload.triggerNodeId ? { triggerNodeId: payload.triggerNodeId } : {}), items: payload.items ?? [] },
        actor(req),
      );
    } catch (e) {
      // A full queue already stored this payload as a new dead letter.
      if (!(e instanceof HttpError && e.code === 'QUEUE_FULL'))
        ctx.store.deadLetters.add({ workflowId: entry.workflow_id, executionId: entry.execution_id, reason: entry.reason, payload: entry.payload });
      throw e;
    }
    ctx.store.kv.set(DLQ_REPLAY_NS, rec.id, { workflowId: entry.workflow_id, reason: entry.reason, payload: entry.payload, executionId: entry.execution_id });
    return { executionId: rec.id };
  });
  app.get('/api/audit', async (req) => {
    requireRole(req, 'admin');
    return ctx.store.audit.list(500);
  });
  app.get('/api/settings', async () => readAppSettings(ctx));
  app.patch('/api/settings', async (req) => {
    requireRole(req, 'admin');
    const next = { ...readAppSettings(ctx), ...body(SettingsPatchSchema, req) };
    ctx.store.settings.set('app', next);
    ctx.store.audit.record(actor(req), 'settings.update', 'app', next);
    return next;
  });
  app.post('/api/backup', async (req) => {
    requireRole(req, 'admin');
    const file = ctx.backup();
    ctx.store.audit.record(actor(req), 'backup.create', file);
    return { file };
  });

  // ---- live events (SSE) ----
  app.get('/api/events', (req, reply) => {
    const q = z.object({ workflowId: z.string().optional(), executionId: z.string().optional() }).parse(req.query);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': connected\n\n');
    const send = (e: EngineEvent) => {
      if (q.workflowId && 'workflowId' in e && e.workflowId !== q.workflowId) return;
      if (q.executionId && (!('executionId' in e) || e.executionId !== q.executionId)) return;
      res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    };
    const unsubscribe = ctx.bus.subscribe(send);
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });
  });

  app.get('/api/openapi.json', async () => openApiDocument(ctx.config.appVersion));
}

function openApiDocument(version: string): unknown {
  const paths: Record<string, Record<string, { summary: string }>> = {};
  for (const r of ROUTE_LIST) {
    const [method, url] = r.split(' ') as [string, string];
    const p = url.replace(/:(\w+)/g, '{$1}');
    paths[p] = { ...(paths[p] ?? {}), [method.toLowerCase()]: { summary: `${method} ${url}` } };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'PulseFlow local API',
      version,
      description: 'Loopback API used by the PulseFlow desktop app, CLI and automation. All /api routes except /api/health require a bearer token.',
    },
    paths,
  };
}

const ROUTE_LIST = [
  'GET /api/health',
  'GET /api/app/info',
  'POST /api/auth/setup',
  'POST /api/auth/login',
  'POST /api/auth/logout',
  'GET /api/auth/me',
  'GET /api/users',
  'POST /api/users',
  'POST /api/tokens',
  'GET /api/nodes',
  'GET /api/credential-types',
  'GET /api/credentials',
  'POST /api/credentials',
  'GET /api/credentials/:id',
  'PATCH /api/credentials/:id',
  'DELETE /api/credentials/:id',
  'GET /api/workflows',
  'POST /api/workflows',
  'GET /api/workflows/:id',
  'PATCH /api/workflows/:id',
  'DELETE /api/workflows/:id',
  'POST /api/workflows/:id/duplicate',
  'POST /api/workflows/:id/validate',
  'POST /api/validate',
  'POST /api/workflows/:id/publish',
  'POST /api/workflows/:id/activate',
  'POST /api/workflows/:id/deactivate',
  'GET /api/workflows/:id/versions',
  'GET /api/workflows/:id/versions/:versionId',
  'POST /api/workflows/:id/versions/:versionId/restore',
  'PUT /api/workflows/:id/permissions',
  'GET /api/workflows/:id/triggers',
  'POST /api/workflows/:id/webhooks/:nodeId/rotate',
  'POST /api/workflows/:id/run',
  'GET /api/executions',
  'GET /api/executions/stats',
  'GET /api/executions/:id',
  'POST /api/executions/:id/cancel',
  'POST /api/executions/:id/retry',
  'POST /api/executions/:id/wait',
  'GET /api/templates',
  'GET /api/templates/:id',
  'POST /api/templates/:id/instantiate',
  'POST /api/export',
  'POST /api/import',
  'GET /api/notifications',
  'POST /api/notifications/read',
  'GET /api/dead-letters',
  'DELETE /api/dead-letters/:id',
  'POST /api/dead-letters/:id/replay',
  'GET /api/audit',
  'GET /api/settings',
  'PATCH /api/settings',
  'POST /api/backup',
  'GET /api/events',
  'GET /api/openapi.json',
  'ALL /hooks/:token',
];
