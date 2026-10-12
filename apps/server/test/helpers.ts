import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ExecutionStep, VariableValue } from '@pulseflow/contracts';
import { makeTempDir, removeDir } from '@pulseflow/testing';
import type { ExecutionRecord } from '@pulseflow/storage';
import { buildConfig, createHost, type Host, type HostConfig } from '../src/index';

export const TEST_TOKEN = 'test-token-0123456789abcdef';

export interface TestHost extends Host {
  dataDir: string;
  api: <T = unknown>(method: string, url: string, body?: unknown, token?: string | null) => Promise<{ status: number; body: T; headers: Headers }>;
  dispose: () => Promise<void>;
}

export async function startTestHost(overrides: Partial<HostConfig> = {}, opts: { startTriggers?: boolean } = {}): Promise<TestHost> {
  const dataDir = overrides.dataDir ?? makeTempDir();
  const config = buildConfig({ dataDir, port: 0, logLevel: 'silent', masterKey: crypto.randomBytes(32), localToken: TEST_TOKEN, fixtures: true, ...overrides });
  const host = await createHost(config, { startTriggers: opts.startTriggers ?? true, log: () => undefined });
  const api: TestHost['api'] = async (method, url, body, token = TEST_TOKEN) => {
    const res = await fetch(`${host.url}${url}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed as never, headers: res.headers };
  };
  return {
    ...host,
    dataDir,
    api,
    dispose: async () => {
      await host.close();
      if (!overrides.dataDir) removeDir(dataDir);
    },
  };
}

export interface TemplateRun {
  workflowId: string;
  templateDir: string;
  execution: ExecutionRecord;
  steps: ExecutionStep[];
  step: (nodeId: string) => ExecutionStep | undefined;
  file: (rel: string) => string;
  exists: (rel: string) => boolean;
}

export async function instantiate(host: TestHost, templateId: string, opts: { demo?: boolean; variables?: Record<string, VariableValue> } = {}) {
  const res = await host.api<{ workflow: { id: string }; templateDir: string }>('POST', `/api/templates/${templateId}/instantiate`, { demo: opts.demo ?? false, ...(opts.variables ? { variables: opts.variables } : {}) });
  if (res.status !== 200) throw new Error(`instantiate ${templateId} failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { workflowId: res.body.workflow.id, templateDir: res.body.templateDir };
}

export async function runWorkflow(host: TestHost, workflowId: string, body: Record<string, unknown> = {}): Promise<{ execution: ExecutionRecord; steps: ExecutionStep[] }> {
  const res = await host.api<{ executionId: string }>('POST', `/api/workflows/${workflowId}/run`, { ...body, wait: false });
  if (res.status !== 200) throw new Error(`run failed: ${res.status} ${JSON.stringify(res.body)}`);
  const execution = await host.ctx.executions.waitFor(res.body.executionId, 60_000);
  return { execution, steps: host.ctx.store.steps.list(execution.id) };
}

export async function runTemplate(host: TestHost, templateId: string, opts: { demo?: boolean; variables?: Record<string, VariableValue>; run?: Record<string, unknown> } = {}): Promise<TemplateRun> {
  const { workflowId, templateDir } = await instantiate(host, templateId, opts);
  const { execution, steps } = await runWorkflow(host, workflowId, opts.run ?? {});
  return withFiles({ workflowId, templateDir, execution, steps });
}

export function withFiles(r: Omit<TemplateRun, 'step' | 'file' | 'exists'>): TemplateRun {
  return {
    ...r,
    step: (nodeId) => [...r.steps].reverse().find((s) => s.nodeId === nodeId),
    file: (rel) => fs.readFileSync(path.join(r.templateDir, rel), 'utf8'),
    exists: (rel) => fs.existsSync(path.join(r.templateDir, rel)),
  };
}

export function stepSummary(steps: ExecutionStep[]): string {
  return steps.map((s) => `${s.nodeId}:${s.state}${s.error ? `(${s.error.code}: ${s.error.message})` : ''}`).join(' | ');
}
