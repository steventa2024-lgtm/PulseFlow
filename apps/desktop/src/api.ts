import type { NodeManifest, WorkflowGraph } from "@pulseflow/contracts";

export interface Issue {
  level: "error" | "warning";
  code: string;
  message: string;
  nodeId?: string;
}

export interface WorkflowSummary {
  id: string;
  name: string;
  description: string;
  tags: string[];
  active: boolean;
  updatedAt: string;
  templateId: string | null;
  tier: string | null;
  nodeCount: number;
}

export interface WorkflowRecord {
  id: string;
  name: string;
  description: string;
  tags: string[];
  active: boolean;
  updatedAt: string;
  draftGraph: WorkflowGraph;
}

export interface ExecutionRecord {
  id: string;
  workflowId: string;
  state: string;
  queuedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  errorSummary: string | null;
  errorCode: string | null;
  triggerType: string;
}

export interface StepRecord {
  id: string;
  nodeId: string;
  attempt: number;
  state: string;
  startedAt: string | null;
  endedAt: string | null;
  input: unknown;
  output: unknown;
  errorMessage: string | null;
  logs: unknown[];
}

export interface TemplateCard {
  id: string;
  tier: "A" | "B";
  name: string;
  description: string;
  category: string;
  difficulty: string;
  trigger: string;
  permissions: string[];
  services: string[];
  setupMinutes: number;
  offline: boolean;
  credentialKind?: string;
  docs: string;
  workflowId: string;
  liveAvailable: boolean;
  graph: WorkflowGraph;
}

async function parse<T>(response: Response): Promise<T> {
  const data = (await response.json().catch(() => ({ error: response.statusText }))) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
  return data;
}

export async function bootstrapSession(): Promise<boolean> {
  const response = await fetch("/api/v1/session", { credentials: "include" });
  if (!response.ok) throw new Error("The local API did not start a session");
  return true;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("x-pulseflow-client", "studio");
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(path, { ...init, headers, credentials: "include" });
  return parse<T>(response);
}

export function listWorkflows() {
  return api<{ workflows: WorkflowSummary[] }>("/api/v1/workflows");
}

export function getWorkflow(id: string) {
  return api<{ workflow: WorkflowRecord; validation: { ok: boolean; errors: Issue[]; warnings: Issue[] } }>(`/api/v1/workflows/${id}`);
}

export function saveWorkflow(id: string, graph: WorkflowGraph, name?: string) {
  return api<{ workflow: WorkflowRecord; validation: { ok: boolean; errors: Issue[]; warnings: Issue[] } }>(`/api/v1/workflows/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ graph, name }),
  });
}

export function listNodes() {
  return api<{ nodes: NodeManifest[] }>("/api/v1/nodes");
}

export function runWorkflow(id: string, mode: "production" | "demo" | "debug" | "live", payload?: unknown) {
  return api<{ result: { state: string; executionId: string; error?: string }; execution: ExecutionRecord; steps: StepRecord[] }>(
    `/api/v1/workflows/${id}/run`,
    { method: "POST", body: JSON.stringify({ mode, payload }) },
  );
}

export function activateWorkflow(id: string) {
  return api<{ versionId: string; webhooks: Array<{ id: string; secret: string }> }>(`/api/v1/workflows/${id}/activate`, {
    method: "POST",
    body: "{}",
  });
}

export function deactivateWorkflow(id: string) {
  return api<{ workflow: WorkflowRecord }>(`/api/v1/workflows/${id}/deactivate`, { method: "POST", body: "{}" });
}

export function listExecutions(workflowId?: string) {
  const query = workflowId ? `?workflowId=${encodeURIComponent(workflowId)}` : "";
  return api<{ executions: ExecutionRecord[] }>(`/api/v1/executions${query}`);
}

export function getExecution(id: string) {
  return api<{ execution: ExecutionRecord; steps: StepRecord[] }>(`/api/v1/executions/${id}`);
}

export function listTemplates() {
  return api<{ templates: TemplateCard[] }>("/api/v1/templates");
}

export function listFiles(root: "demo" | "out" | "inbox" | "backup") {
  return api<{ files: string[] }>(`/api/v1/files?root=${root}`);
}

export function readFilePreview(root: "demo" | "out" | "inbox" | "backup", name: string) {
  return api<{ name: string; text: string; bytes: number }>(`/api/v1/files?root=${root}&name=${encodeURIComponent(name)}`);
}

export function getSettings() {
  return api<{
    telemetry: boolean;
    backgroundExecution: boolean;
    tutorialDismissed: boolean;
    retentionDays: number;
    roots: string[];
  }>("/api/v1/settings");
}

export function patchSettings(patch: Record<string, unknown>) {
  return api<{ ok: boolean }>("/api/v1/settings", { method: "PATCH", body: JSON.stringify(patch) });
}

export function listCredentials() {
  return api<{ credentials: Array<{ id: string; name: string; kind: string; createdAt: string }> }>("/api/v1/credentials");
}

export function createCredential(input: { name: string; kind: string; secret: unknown }) {
  return api<{ credential: { id: string; name: string; kind: string } }>("/api/v1/credentials", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function addRoot(folder: string) {
  return api<{ roots: string[] }>("/api/v1/roots", { method: "POST", body: JSON.stringify({ path: folder }) });
}

export function exportWorkflow(id: string) {
  return api<unknown>(`/api/v1/workflows/${id}/export`);
}

export function importBundle(bundle: unknown) {
  return api<{ workflows: WorkflowSummary[] }>("/api/v1/import", { method: "POST", body: JSON.stringify(bundle) });
}

export function listVersions(id: string) {
  return api<{ versions: Array<{ id: string; createdAt: string; note: string; published: boolean }> }>(`/api/v1/workflows/${id}/versions`);
}

export function restoreVersion(workflowId: string, versionId: string) {
  return api(`/api/v1/workflows/${workflowId}/restore/${versionId}`, { method: "POST", body: "{}" });
}

export function pinNode(workflowId: string, nodeId: string, data: unknown) {
  return api("/api/v1/pins", { method: "POST", body: JSON.stringify({ workflowId, nodeId, data }) });
}

export function testNode(workflowId: string, nodeId: string) {
  return api<{ result: { state: string; executionId: string; error?: string }; steps: StepRecord[]; error?: string }>(
    `/api/v1/workflows/${workflowId}/nodes/${nodeId}/test`,
    { method: "POST", body: "{}" },
  );
}
