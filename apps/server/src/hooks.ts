import type { Item, NodeInstance } from '@pulseflow/contracts';
import { safeJsonParse, timingSafeEqualStr, verifyHmacSignature } from '@pulseflow/security';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { HttpError } from './credentials';
import type { HostContext } from './host';

const DROP_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization', 'x-pulseflow-signature']);
const RATE_PER_MINUTE = 120;
const SYNC_RESPONSE_TIMEOUT_MS = 30_000;

class RateLimiter {
  readonly #buckets = new Map<string, { tokens: number; at: number }>();
  take(key: string, perMinute: number): boolean {
    const now = Date.now();
    const b = this.#buckets.get(key) ?? { tokens: perMinute, at: now };
    b.tokens = Math.min(perMinute, b.tokens + ((now - b.at) / 60_000) * perMinute);
    b.at = now;
    if (b.tokens < 1) {
      this.#buckets.set(key, b);
      return false;
    }
    b.tokens -= 1;
    this.#buckets.set(key, b);
    if (this.#buckets.size > 10_000) this.#buckets.clear();
    return true;
  }
}

function parseBody(req: FastifyRequest): unknown {
  const raw = req.rawBody ?? '';
  if (!raw) return {};
  const type = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (type === 'application/json' || type.endsWith('+json')) {
    try {
      return safeJsonParse(raw);
    } catch (e) {
      throw new HttpError(400, 'INVALID_JSON', `Body is not valid JSON: ${(e as Error).message}`);
    }
  }
  if (type === 'application/x-www-form-urlencoded') return Object.fromEntries(new URLSearchParams(raw));
  return { text: raw };
}

export function registerHooks(app: FastifyInstance, ctx: HostContext): void {
  const limiter = new RateLimiter();

  const handler = async (req: FastifyRequest<{ Params: { token: string } }>, reply: FastifyReply) => {
    const token = req.params.token;
    if (!/^[A-Za-z0-9_-]{16,100}$/.test(token)) throw new HttpError(404, 'NOT_FOUND', 'Unknown webhook');
    const hook = ctx.store.webhooks.byToken(token);
    const wf = hook ? ctx.store.workflows.get(hook.workflow_id) : undefined;
    if (!hook || !wf?.active || !wf.publishedVersionId) throw new HttpError(404, 'NOT_FOUND', 'Unknown or inactive webhook');
    const version = ctx.store.versions.get(wf.publishedVersionId)!;
    const node = version.graph.nodes.find((n): n is NodeInstance => n.id === hook.node_id && !n.disabled);
    if (!node) throw new HttpError(404, 'NOT_FOUND', 'Webhook node no longer exists');
    if (!limiter.take(token, RATE_PER_MINUTE)) {
      reply.header('retry-after', '30');
      throw new HttpError(429, 'RATE_LIMITED', 'Too many requests for this webhook');
    }
    const p = node.parameters;
    const method = String(p.method ?? 'POST');
    if (req.method !== method) throw new HttpError(405, 'METHOD_NOT_ALLOWED', `This webhook accepts ${method}`);
    const raw = req.rawBody ?? '';
    const maxBytes = Math.max(1, Number(p.maxBodyKb ?? 1024)) * 1024;
    if (Buffer.byteLength(raw) > maxBytes) throw new HttpError(413, 'BODY_TOO_LARGE', `Body exceeds ${maxBytes} bytes`);

    const auth = String(p.auth ?? 'none');
    if (auth !== 'none') {
      const credId = String(p.secretCredential ?? '');
      const secret = credId ? ctx.credentials.resolve(credId, () => undefined).data.secret : undefined;
      if (!secret) throw new HttpError(500, 'MISCONFIGURED', 'Webhook secret credential is missing');
      const headerName = String(p.headerName ?? 'x-pulseflow-signature').toLowerCase();
      const provided = String(req.headers[headerName] ?? '');
      const ok = auth === 'header' ? timingSafeEqualStr(provided, secret) : verifyHmacSignature(secret, raw, provided);
      if (!ok) throw new HttpError(401, 'INVALID_SIGNATURE', 'Webhook authentication failed');
    }

    const idem = req.headers['idempotency-key'];
    if (typeof idem === 'string' && idem) {
      if (idem.length > 200) throw new HttpError(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key is too long');
      if (ctx.store.dedupe.checkAndRecord(`hook:${wf.id}:${node.id}`, idem)) return reply.code(200).send({ ok: true, duplicate: true });
    }

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (!DROP_HEADERS.has(k) && k !== String(p.headerName ?? '').toLowerCase()) headers[k] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
    const query = { ...(req.query as Record<string, string>) };
    const items: Item[] = [{ json: { method: req.method, headers, query, body: parseBody(req) as Record<string, unknown>, receivedAt: ctx.clock.now().toISOString() } }];
    const rec = ctx.executions.enqueue({ workflowId: wf.id, workflowName: wf.name, versionId: version.id, graph: version.graph, settings: { ...version.settings, permissions: wf.settings.permissions }, triggerNodeId: node.id, items, mode: 'trigger' });

    const mode = String(p.responseMode ?? 'onReceived');
    if (mode === 'onReceived') return reply.code(202).send({ ok: true, executionId: rec.id });
    const done = await ctx.executions.waitFor(rec.id, SYNC_RESPONSE_TIMEOUT_MS).catch(() => null);
    if (!done) return reply.code(202).send({ ok: true, executionId: rec.id, pending: true });
    const outputs = ctx.executions.rawOutputs(done.id);
    if (mode === 'responseNode') {
      for (const step of ctx.store.steps.list(done.id).reverse()) {
        if (step.nodeType !== 'core.webhookResponse' || step.state !== 'succeeded') continue;
        const resp = outputs[step.nodeId]?.main?.[0]?.json.webhookResponse as { status: number; body: unknown; headers: Record<string, string> } | undefined;
        if (!resp) continue;
        for (const [k, v] of Object.entries(resp.headers ?? {})) if (!/^(set-cookie|content-length|transfer-encoding|connection)$/i.test(k)) reply.header(k, v);
        return reply.code(resp.status).send(resp.body ?? '');
      }
    }
    if (done.state !== 'succeeded') return reply.code(500).send({ ok: false, executionId: done.id, error: done.error });
    const last = ctx.store.steps.list(done.id).filter((s) => s.state === 'succeeded').pop();
    const lastItems = last ? (outputs[last.nodeId]?.main ?? []) : [];
    return reply.code(200).send(mode === 'lastNode' ? { ok: true, executionId: done.id, items: lastItems.map((i) => i.json) } : { ok: true, executionId: done.id });
  };

  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const) {
    app.route<{ Params: { token: string } }>({ method, url: '/hooks/:token', handler });
  }
}
