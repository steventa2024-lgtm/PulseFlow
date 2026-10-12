import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { newToken, type Item, type Workflow, type WorkflowSettings } from '@pulseflow/contracts';
import { connectorNodes, sendSmtpMail } from '@pulseflow/connectors';
import { NodeError, SystemClock, createHttpClient, createScopedFs, type Clock, type NodeRegistry, type NodeServices } from '@pulseflow/engine';
import { createCoreRegistry } from '@pulseflow/nodes-core';
import { SecretBox, assertUrlAllowed, type NetworkPolicy } from '@pulseflow/security';
import { Store, openDatabase, type Database, type ExecutionRecord } from '@pulseflow/storage';
import { readAppSettings, registerApi } from './api';
import { AuthService, checkHost, checkOrigin, roleForRequest, requireRole } from './auth';
import type { HostConfig } from './config';
import { CredentialService, HttpError } from './credentials';
import { EventBus } from './events';
import { ExecutionService, subworkflowError, type ServiceFactoryInput } from './executions';
import { createFixtureState, registerFixtures, startSmtpSink, type FixtureState } from './fixtures';
import { registerHooks } from './hooks';
import { TriggerManager } from './triggers';
import { WorkflowService } from './workflows';

export const DEMO_SMTP_CREDENTIAL_ID = 'cred_demo_smtp';

export const UI_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const OLLAMA_HOSTS = ['127.0.0.1:11434', 'localhost:11434'];

export interface HostContext {
  config: HostConfig;
  db: Database;
  store: Store;
  registry: NodeRegistry;
  clock: Clock;
  bus: EventBus;
  box: SecretBox;
  auth: AuthService;
  credentials: CredentialService;
  executions: ExecutionService;
  triggers: TriggerManager;
  workflows: WorkflowService;
  fixtureState: FixtureState;
  fixturesUrl: () => string;
  publicBaseUrl: () => string;
  rotateWebhook: (workflowId: string, nodeId: string) => void;
  backup: () => string;
}

export interface Host {
  app: FastifyInstance;
  ctx: HostContext;
  url: string;
  port: number;
  close: () => Promise<void>;
}

export interface HostOptions {
  clock?: Clock;
  /** Called for every notification (desktop shows a native toast). */
  onNotify?: (n: { title: string; body: string; workflowId: string }) => void;
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** Start schedules/watchers/pollers for active workflows (off in some tests). */
  startTriggers?: boolean;
}

export async function createHost(config: HostConfig, options: HostOptions = {}): Promise<Host> {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.demoDir, { recursive: true });
  const log = options.log ?? ((level, msg) => (config.logLevel !== 'silent' ? console[level === 'info' ? 'log' : level](`[pulseflow] ${msg}`) : undefined));
  const db = openDatabase(path.join(config.dataDir, 'pulseflow.db'));
  db.migrate();
  const store = new Store(db);
  const workspace = store.workspaces.ensureDefault();
  const clock = options.clock ?? new SystemClock();
  const bus = new EventBus();
  const box = new SecretBox(config.masterKey);
  const registry = createCoreRegistry(connectorNodes);
  const credentials = new CredentialService(store, box, workspace.id);
  const auth = new AuthService(store, config.mode, config.localToken);
  const fixtureState = createFixtureState();

  let port = config.port;
  const origin = () => `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${port}`;
  const fixturesUrl = () => `${origin()}/demo`;
  const publicBaseUrl = () => (config.publicUrl ?? origin()).replace(/\/+$/, '');
  let smtpPort = 0;

  const networkPolicy = (settings: WorkflowSettings): NetworkPolicy => ({
    allowPrivateNetwork: settings.permissions.allowPrivateNetwork,
    allowHosts: [...(config.fixtures ? [`127.0.0.1:${port}`] : []), ...OLLAMA_HOSTS],
  });
  const appOwned = [config.demoDir];
  const makeFs = (wf: { settings: WorkflowSettings }) => createScopedFs({ grants: wf.settings.permissions.fs, appOwned });
  const makeHttp = (wf: { settings: WorkflowSettings }) => createHttpClient(networkPolicy(wf.settings), { userAgent: `PulseFlow/${config.appVersion}` });

  let executions!: ExecutionService;

  const buildServices = (input: ServiceFactoryInput): NodeServices => {
    const kvNs = `wf:${input.workflowId}`;
    const settings = readAppSettings({ store });
    const env: Record<string, string> = {};
    for (const k of settings.envAllowList) if (process.env[k] !== undefined) env[k] = process.env[k]!;
    return {
      fs: makeFs(input),
      http: makeHttp(input),
      kv: {
        get: async (k) => store.kv.get(kvNs, k),
        set: async (k, v) => store.kv.set(kvNs, k, v),
        delete: async (k) => store.kv.delete(kvNs, k),
        list: async (prefix) => store.kv.list(kvNs, prefix ?? ''),
      },
      dedupe: {
        checkAndRecord: async (scope, key) => store.dedupe.checkAndRecord(`${kvNs}:${scope}`, key),
        has: async (scope, key) => store.dedupe.has(`${kvNs}:${scope}`, key),
      },
      notify: async (n) => {
        const row = store.notifications.add({
          title: n.title.slice(0, 200),
          body: n.body.slice(0, 2000),
          workflowId: input.workflowId,
          executionId: input.executionId,
        });
        bus.emit({ type: 'notification', id: row.id, title: row.title, body: row.body, workflowId: input.workflowId, ts: row.ts });
        options.onNotify?.({ title: row.title, body: row.body, workflowId: input.workflowId });
      },
      getCredential: async (id) => credentials.resolve(id, (secret) => input.secrets.add(secret)),
      runSubworkflow: async (workflowId, items, opts) => {
        const target = store.workflows.get(workflowId);
        if (!target) throw new NodeError('SUBWORKFLOW_NOT_FOUND', `Workflow ${workflowId} does not exist`);
        const version = target.publishedVersionId ? store.versions.get(target.publishedVersionId) : undefined;
        const graph = version?.graph ?? target.draft;
        const trigger = graph.nodes.find((n) => n.type === 'core.workflowCalledTrigger' && !n.disabled);
        if (!trigger) throw new NodeError('SUBWORKFLOW_NO_TRIGGER', `"${target.name}" needs a "When Called by Another Workflow" trigger`);
        const { record, outcome } = await executions.runChild({
          workflowId: target.id,
          workflowName: target.name,
          versionId: version?.id ?? null,
          graph,
          settings: { ...(version?.settings ?? target.settings), permissions: target.settings.permissions },
          triggerNodeId: trigger.id,
          items,
          mode: 'subworkflow',
          parentExecutionId: opts.parentExecutionId,
          depth: opts.depth,
        });
        if (outcome.state !== 'succeeded')
          throw subworkflowError(`Sub-workflow "${target.name}" ${outcome.state} (execution ${record.id}): ${outcome.error?.message ?? ''}`);
        return outcome.resultItems;
      },
      sendEmail: async (msg) => {
        const cred = credentials.resolve(msg.credentialId, (s) => input.secrets.add(s));
        if (cred.type !== 'smtp') throw new NodeError('INVALID_CREDENTIAL', 'Credential is not an SMTP account');
        await assertUrlAllowed(`http://${cred.data.host}:${cred.data.port ?? 587}`, {
          ...networkPolicy(input.settings),
          allowHosts: [...(networkPolicy(input.settings).allowHosts ?? []), ...(smtpPort ? [`127.0.0.1:${smtpPort}`] : [])],
        }).catch((e: Error) => {
          throw new NodeError('NETWORK_DENIED', e.message);
        });
        return sendSmtpMail(cred, msg);
      },
      app: { demoDir: config.demoDir, dataDir: config.dataDir, fixturesUrl: fixturesUrl() },
      advancedNodesEnabled: settings.advancedNodes,
      env,
    };
  };

  const onFinished = (rec: ExecutionRecord) => {
    if (rec.state !== 'failed' && rec.state !== 'timed_out') return;
    if (rec.graph.nodes.find((n) => n.id === rec.triggerNodeId)?.type === 'core.errorTrigger') return;
    const targets = new Set<string>();
    if (rec.settings.errorWorkflowId) targets.add(rec.settings.errorWorkflowId);
    for (const wf of store.workflows.listActive()) {
      const v = wf.publishedVersionId ? store.versions.get(wf.publishedVersionId) : undefined;
      if (v?.graph.nodes.some((n) => n.type === 'core.errorTrigger' && !n.disabled && n.parameters.scope === 'all')) targets.add(wf.id);
    }
    targets.delete(rec.workflowId);
    for (const id of targets) {
      const wf = store.workflows.get(id);
      const v = wf?.publishedVersionId ? store.versions.get(wf.publishedVersionId) : undefined;
      const trigger = v?.graph.nodes.find((n) => n.type === 'core.errorTrigger' && !n.disabled);
      if (!wf || !v || !trigger) continue;
      const items: Item[] = [
        {
          json: {
            workflowId: rec.workflowId,
            workflowName: rec.workflowName,
            executionId: rec.id,
            state: rec.state,
            error: rec.error,
            failedAt: rec.finishedAt,
          },
        },
      ];
      try {
        executions.enqueue({
          workflowId: wf.id,
          workflowName: wf.name,
          versionId: v.id,
          graph: v.graph,
          settings: { ...v.settings, permissions: wf.settings.permissions },
          triggerNodeId: trigger.id,
          items,
          mode: 'trigger',
        });
      } catch (e) {
        log('warn', `Error workflow ${wf.name} could not start: ${(e as Error).message}`);
      }
    }
  };

  executions = new ExecutionService({
    store,
    registry,
    clock,
    bus,
    box,
    buildServices,
    maxConcurrent: config.maxConcurrentExecutions,
    globalSecrets: () => credentials.allSecretValues(),
    onFinished,
  });
  const triggers = new TriggerManager({
    store,
    clock,
    registry,
    executions,
    makeFs: (wf: Workflow) => makeFs(wf),
    makeHttp: (wf: Workflow) => makeHttp(wf),
    log,
    app: {
      demoDir: config.demoDir,
      dataDir: config.dataDir,
      get fixturesUrl() {
        return fixturesUrl();
      },
    },
  });
  const workflows = new WorkflowService({
    store,
    registry,
    clock,
    bus,
    executions,
    triggers,
    credentials,
    workspaceId: workspace.id,
    app: { name: 'PulseFlow', version: config.appVersion, demoDir: config.demoDir, fixturesUrl },
  });

  const ctx: HostContext = {
    config,
    db,
    store,
    registry,
    clock,
    bus,
    box,
    auth,
    credentials,
    executions,
    triggers,
    workflows,
    fixtureState,
    fixturesUrl,
    publicBaseUrl,
    rotateWebhook: (wfId, nodeId) => store.webhooks.rotate(wfId, nodeId, newToken(24)),
    backup: () => {
      const dir = path.join(config.dataDir, 'backups');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `pulseflow-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
      db.backupTo(file);
      return file;
    },
  };

  const app = Fastify({ logger: false, bodyLimit: 16 * 1024 * 1024, trustProxy: false });
  app.addContentTypeParser(['application/json', 'application/x-www-form-urlencoded', 'text/plain'], { parseAs: 'string' }, (req, raw, done) => {
    const text = typeof raw === 'string' ? raw : raw.toString('utf8');
    req.rawBody = text;
    const type = String(req.headers['content-type'] ?? '');
    if (!type.includes('json') || req.url.startsWith('/hooks/')) return done(null, undefined);
    if (!text) return done(null, {});
    try {
      done(
        null,
        JSON.parse(text, (k, v: unknown) => (k === '__proto__' || k === 'constructor' ? undefined : v)),
      );
    } catch {
      done(new HttpError(400, 'INVALID_JSON', 'Request body is not valid JSON'), undefined);
    }
  });
  app.addContentTypeParser('*', { parseAs: 'string' }, (req, raw, done) => {
    req.rawBody = typeof raw === 'string' ? raw : raw.toString('utf8');
    done(null, undefined);
  });

  const allowedHosts = () => [
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    ...(config.publicUrl ? [new URL(config.publicUrl).host.toLowerCase()] : []),
    ...(config.mode === 'server' && config.host !== '127.0.0.1' ? ['*'] : []),
  ];
  const allowedOrigins = () => [
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    ...(config.publicUrl ? [new URL(config.publicUrl).origin.toLowerCase()] : []),
  ];

  app.addHook('onRequest', async (req, reply) => {
    const hosts = allowedHosts();
    if (!hosts.includes('*') && !checkHost(req, reply, () => hosts)) return reply;
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    reply.header('cross-origin-opener-policy', 'same-origin');
    if (!req.url.startsWith('/api/')) return;
    checkOrigin(req, allowedOrigins);
    const open =
      req.url === '/api/health' ||
      req.url.startsWith('/api/app/info') ||
      (config.mode === 'server' && (req.url.startsWith('/api/auth/login') || req.url.startsWith('/api/auth/setup')));
    if (open) return;
    req.principal = auth.authenticate(req);
    requireRole(req, roleForRequest(req.method));
  });

  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof HttpError)
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) } });
    if (err instanceof NodeError) return reply.code(400).send({ error: { code: err.code, message: err.message } });
    const e = err as { statusCode?: number; code?: string; message?: string; validation?: unknown };
    if (e.statusCode && e.statusCode < 500)
      return reply.code(e.statusCode).send({ error: { code: e.code ?? 'BAD_REQUEST', message: e.message ?? 'Bad request' } });
    if ((err as { name?: string }).name === 'ZodError')
      return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: 'Invalid request parameters' } });
    log('error', `Unhandled API error: ${(err as Error).stack ?? String(err)}`);
    return reply.code(500).send({ error: { code: 'INTERNAL', message: 'Internal error (see logs)' } });
  });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/hooks/') || req.url.startsWith('/demo'))
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
    if (config.staticDir && req.method === 'GET') return reply.type('text/html').sendFile('index.html');
    return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } });
  });

  registerApi(app, ctx);
  registerHooks(app, ctx);
  if (config.fixtures) registerFixtures(app, fixtureState, fixturesUrl);
  if (config.staticDir && fs.existsSync(path.join(config.staticDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: config.staticDir, index: ['index.html'] });
    app.addHook('onSend', async (req, reply, payload) => {
      if (!req.url.startsWith('/api/') && !req.url.startsWith('/hooks/') && !req.url.startsWith('/demo')) {
        reply.header('content-security-policy', UI_CSP);
        reply.header('x-content-type-options', 'nosniff');
        reply.header('referrer-policy', 'no-referrer');
      }
      return payload;
    });
  }

  await app.listen({ host: config.host, port: config.port });
  port = (app.server.address() as { port: number }).port;

  let smtpClose: (() => Promise<void>) | null = null;
  if (config.fixtures) {
    const sink = await startSmtpSink(fixtureState);
    smtpPort = sink.port;
    smtpClose = sink.close;
    const demoCred = { name: 'Demo SMTP sink (local, never delivers)', type: 'smtp', data: { host: '127.0.0.1', port: String(sink.port), secure: 'false' } };
    if (credentials.get(DEMO_SMTP_CREDENTIAL_ID)) credentials.update(DEMO_SMTP_CREDENTIAL_ID, { data: demoCred.data });
    else credentials.create({ ...demoCred, id: DEMO_SMTP_CREDENTIAL_ID });
  }

  const recovery = executions.recover();
  if (recovery.interrupted || recovery.resumedWaits)
    log('info', `Recovery: ${recovery.interrupted} interrupted run(s) marked failed, ${recovery.resumedWaits} wait(s) rescheduled`);
  if (options.startTriggers !== false) triggers.startAll({ startup: true });
  const retention = readAppSettings({ store }).retentionDays;
  const pruned = store.executions.prune({ maxAgeDays: retention });
  if (pruned) log('info', `Pruned ${pruned} execution(s) older than ${retention} days`);

  let closed = false;
  return {
    app,
    ctx,
    url: origin(),
    port,
    close: async () => {
      if (closed) return;
      closed = true;
      triggers.stopAll();
      await executions.stop(3000);
      await app.close();
      await smtpClose?.();
      db.close();
    },
  };
}
