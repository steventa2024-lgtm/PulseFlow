import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkflowGraph } from '@pulseflow/contracts';
import { hmacSha256Hex } from '@pulseflow/security';
import { chain, node } from '@pulseflow/templates';
import { startTestHost, type TestHost } from '../helpers';

let host: TestHost;
beforeAll(async () => {
  host = await startTestHost();
});
afterAll(async () => {
  await host.dispose();
});

const hookGraph = (params: Record<string, unknown>): WorkflowGraph => ({
  schemaVersion: 1,
  nodes: [
    node('hook', 'core.webhookTrigger', 'Hook', 0, 0, { method: 'POST', responseMode: 'lastNode', auth: 'none', maxBodyKb: 4, ...params }),
    node('s', 'core.set', 'Echo', 1, 0, { fields: [{ name: 'got', value: '{{ $json.body.msg }}' }], keepExisting: false }),
  ],
  edges: chain('hook', 's'),
});

async function activeHook(params: Record<string, unknown>): Promise<string> {
  const wf = await host.api<{ id: string }>('POST', '/api/workflows', { name: `hook-${crypto.randomUUID().slice(0, 6)}`, draft: hookGraph(params) });
  const act = await host.api('POST', `/api/workflows/${wf.body.id}/activate`, {});
  expect(act.status, JSON.stringify(act.body)).toBe(200);
  const triggers = await host.api<{ webhookPath?: string }[]>('GET', `/api/workflows/${wf.body.id}/triggers`);
  return triggers.body.find((t) => t.webhookPath)!.webhookPath!;
}

const post = (path: string, body: string, headers: Record<string, string> = {}) =>
  fetch(`${host.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });

describe('API security', () => {
  it('requires the local token for /api routes', async () => {
    expect((await host.api('GET', '/api/workflows', undefined, null)).status).toBe(401);
    expect((await host.api('GET', '/api/workflows', undefined, 'wrong')).status).toBe(401);
    expect((await host.api('GET', '/api/workflows')).status).toBe(200);
    expect((await host.api('GET', '/api/health', undefined, null)).status).toBe(200);
  });

  it('rejects foreign Host headers (DNS rebinding) and cross-origin writes', async () => {
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: host.port, path: '/api/health', headers: { host: 'evil.example:80' } }, (res) =>
        resolve(res.statusCode ?? 0),
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(421);
    const res = await fetch(`${host.url}/api/workflows`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token-0123456789abcdef', 'content-type': 'application/json', origin: 'https://evil.example' },
      body: '{"name":"x"}',
    });
    expect(res.status).toBe(403);
  });

  it('never returns credential secrets and redacts them from execution data', async () => {
    const created = await host.api<{ id: string; fields: string[] }>('POST', '/api/credentials', {
      name: 'Bearer',
      type: 'httpBearer',
      data: { token: 'super-secret-token-value-123' },
    });
    expect(created.status).toBe(200);
    expect(JSON.stringify(created.body)).not.toContain('super-secret');
    const got = await host.api('GET', `/api/credentials/${created.body.id}`);
    expect(JSON.stringify(got.body)).not.toContain('super-secret');
    const wf = await host.api<{ id: string }>('POST', '/api/workflows', {
      name: 'leak-test',
      draft: {
        schemaVersion: 1,
        nodes: [
          node('t', 'core.manualTrigger', 'T', 0, 0),
          node('h', 'core.httpRequest', 'Echo auth', 1, 0, { method: 'GET', url: '{{ $app.fixturesUrl }}/api/health', credential: created.body.id }),
          node('s', 'core.set', 'Leak', 2, 0, { fields: [{ name: 'echo', value: 'token=super-secret-token-value-123' }] }),
        ],
        edges: chain('t', 'h', 's'),
      },
    });
    const run = await host.api<{ executionId: string }>('POST', `/api/workflows/${wf.body.id}/run`, { wait: true });
    const exec = await host.api('GET', `/api/executions/${run.body.executionId}`);
    expect(JSON.stringify(exec.body)).not.toContain('super-secret-token-value-123');
    const bundle = await host.api('POST', '/api/export', { ids: [wf.body.id] });
    expect(JSON.stringify(bundle.body)).not.toContain('super-secret-token-value-123');
    expect(JSON.stringify(bundle.body)).not.toContain(created.body.id);
  });

  it('resets permissions on import and verifies bundle checksums', async () => {
    const wf = await host.api<{ id: string }>('POST', '/api/workflows', {
      name: 'perm',
      draft: { schemaVersion: 1, nodes: [node('t', 'core.manualTrigger', 'T', 0, 0)], edges: [] },
    });
    await host.api('PUT', `/api/workflows/${wf.body.id}/permissions`, {
      fs: [{ path: '/', access: 'readwrite' }],
      allowPrivateNetwork: true,
      notifications: true,
      email: true,
      advancedNodes: true,
    });
    const bundle = (await host.api<Record<string, unknown>>('POST', '/api/export', { ids: [wf.body.id] })).body;
    const tampered = JSON.parse(JSON.stringify(bundle)) as { workflows: { settings: Record<string, unknown> }[] };
    tampered.workflows[0]!.settings.permissions = { fs: [{ path: '/', access: 'readwrite' }], allowPrivateNetwork: true };
    expect((await host.api('POST', '/api/import', tampered)).status).toBe(400);
    const imported = await host.api<{
      workflows: { id: string; active: boolean; settings: { permissions: { fs: unknown[]; allowPrivateNetwork: boolean; email: boolean } } }[];
    }>('POST', '/api/import', bundle);
    expect(imported.status).toBe(200);
    const w = imported.body.workflows[0]!;
    expect(w.active).toBe(false);
    expect(w.settings.permissions.fs).toEqual([]);
    expect(w.settings.permissions.allowPrivateNetwork).toBe(false);
    expect(w.settings.permissions.email).toBe(false);
  });
});

describe('versions', () => {
  it('publishes immutable versions and restores them into the draft', async () => {
    const draft1 = { schemaVersion: 1, nodes: [node('t', 'core.manualTrigger', 'T', 0, 0)], edges: [] };
    const wf = await host.api<{ id: string; draftRevision: number }>('POST', '/api/workflows', { name: 'versions', draft: draft1 });
    const v1 = await host.api<{ id: string; versionNumber: number }>('POST', `/api/workflows/${wf.body.id}/publish`, { note: 'first' });
    expect(v1.body.versionNumber).toBe(1);
    const patched = await host.api<{ draftRevision: number }>('PATCH', `/api/workflows/${wf.body.id}`, {
      draft: { ...draft1, nodes: [...draft1.nodes, node('n', 'core.noop', 'N', 1, 0)] },
      baseRevision: wf.body.draftRevision,
    });
    expect(patched.status).toBe(200);
    expect((await host.api('PATCH', `/api/workflows/${wf.body.id}`, { name: 'stale', baseRevision: wf.body.draftRevision })).status).toBe(409);
    await host.api('POST', `/api/workflows/${wf.body.id}/publish`, { note: 'second' });
    const versions = await host.api<{ versionNumber: number }[]>('GET', `/api/workflows/${wf.body.id}/versions`);
    expect(versions.body.map((v) => v.versionNumber).sort()).toEqual([1, 2]);
    const restored = await host.api<{ draft: WorkflowGraph }>('POST', `/api/workflows/${wf.body.id}/versions/${v1.body.id}/restore`, {});
    expect(restored.body.draft.nodes).toHaveLength(1);
  });
});

describe('webhooks', () => {
  it('runs the workflow and responds with the last node output', async () => {
    const path = await activeHook({});
    const res = await post(path, JSON.stringify({ msg: 'hello' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, items: [{ got: 'hello' }] });
  });

  it('rejects wrong methods, oversized bodies, unknown tokens and invalid JSON', async () => {
    const path = await activeHook({});
    expect((await fetch(`${host.url}${path}`)).status).toBe(405);
    expect((await post(path, JSON.stringify({ msg: 'x'.repeat(5000) }))).status).toBe(413);
    expect((await post('/hooks/doesnotexist0000000000', '{}')).status).toBe(404);
    expect((await post(path, '{not json')).status).toBe(400);
    expect((await post(path, '{"__proto__":{"x":1}}')).status).toBe(400);
  });

  it('verifies HMAC signatures', async () => {
    const cred = await host.api<{ id: string }>('POST', '/api/credentials', {
      name: 'hook secret',
      type: 'webhookSecret',
      data: { secret: 'shh-its-a-secret' },
    });
    const path = await activeHook({ auth: 'hmac', secretCredential: cred.body.id, headerName: 'x-signature' });
    const body = JSON.stringify({ msg: 'signed' });
    expect((await post(path, body, { 'x-signature': 'sha256=deadbeef' })).status).toBe(401);
    expect((await post(path, body)).status).toBe(401);
    const ok = await post(path, body, { 'x-signature': `sha256=${hmacSha256Hex('shh-its-a-secret', body)}` });
    expect(ok.status).toBe(200);
  });

  it('deduplicates by Idempotency-Key', async () => {
    const path = await activeHook({ responseMode: 'onReceived' });
    const first = await post(path, '{"msg":"once"}', { 'idempotency-key': 'abc-123' });
    expect(first.status).toBe(202);
    const second = await post(path, '{"msg":"once"}', { 'idempotency-key': 'abc-123' });
    expect(await second.json()).toMatchObject({ duplicate: true });
  });

  it('stops answering after deactivation', async () => {
    const path = await activeHook({});
    const hook = host.ctx.store.webhooks.byToken(path.split('/').pop()!)!;
    await host.api('POST', `/api/workflows/${hook.workflow_id}/deactivate`, {});
    expect((await post(path, '{"msg":"x"}')).status).toBe(404);
  });
});

describe('server mode auth', () => {
  it('requires an owner setup, then login, and enforces roles', async () => {
    const srv = await startTestHost({ mode: 'server', fixtures: false });
    try {
      expect((await srv.api('GET', '/api/workflows')).status).toBe(401);
      const setup = await srv.api<{ token: string }>(
        'POST',
        '/api/auth/setup',
        { email: 'owner@example.com', name: 'Owner', password: 'long-enough-password' },
        null,
      );
      expect(setup.status).toBe(200);
      expect((await srv.api('POST', '/api/auth/setup', { email: 'x@example.com', name: 'X', password: 'long-enough-password' }, null)).status).toBe(409);
      const owner = setup.body.token;
      expect((await srv.api('GET', '/api/workflows', undefined, owner)).status).toBe(200);
      await srv.api('POST', '/api/users', { email: 'viewer@example.com', name: 'Viewer', password: 'viewer-password-1', role: 'viewer' }, owner);
      expect((await srv.api('POST', '/api/auth/login', { email: 'viewer@example.com', password: 'wrong' }, null)).status).toBe(401);
      const login = await srv.api<{ token: string }>('POST', '/api/auth/login', { email: 'viewer@example.com', password: 'viewer-password-1' }, null);
      expect((await srv.api('GET', '/api/workflows', undefined, login.body.token)).status).toBe(200);
      expect((await srv.api('POST', '/api/workflows', { name: 'nope' }, login.body.token)).status).toBe(403);
      expect((await srv.api('GET', '/api/audit', undefined, login.body.token)).status).toBe(403);
    } finally {
      await srv.dispose();
    }
  });
});

describe('events', () => {
  it('streams execution events over SSE', async () => {
    const wf = await host.api<{ id: string }>('POST', '/api/workflows', {
      name: 'sse',
      draft: { schemaVersion: 1, nodes: [node('t', 'core.manualTrigger', 'T', 0, 0)], edges: [] },
    });
    const controller = new AbortController();
    const res = await fetch(`${host.url}/api/events?workflowId=${wf.body.id}`, {
      headers: { authorization: 'Bearer test-token-0123456789abcdef' },
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    await host.api('POST', `/api/workflows/${wf.body.id}/run`, {});
    let text = '';
    const deadline = Date.now() + 5000;
    while (!text.includes('"state":"succeeded"') && Date.now() < deadline) text += new TextDecoder().decode((await reader.read()).value);
    controller.abort();
    expect(text).toContain('event: execution.updated');
    expect(text).toContain('event: step.updated');
    expect(text).toContain('"state":"succeeded"');
  });
});
