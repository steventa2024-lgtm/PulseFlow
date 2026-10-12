import type {
  AppInfo,
  CredentialMeta,
  CredentialTypeDef,
  EngineEvent,
  Execution,
  ExecutionStep,
  NodeCatalogEntry,
  PermissionGrants,
  TemplateManifest,
  TemplateSummary,
  ValidationResult,
  Workflow,
  WorkflowGraph,
  WorkflowPatch,
  WorkflowVersion,
} from '@pulseflow/contracts';

export interface DesktopBridge {
  connection(): Promise<{ token: string | null; shell: 'desktop'; keyProtection: 'os-keychain' | 'file'; platform: string; versions: Record<string, string> }>;
  selectFolder(title?: string): Promise<string | null>;
  selectFile(title?: string): Promise<string | null>;
  showItemInFolder(p: string): Promise<boolean>;
  openExternal(url: string): Promise<boolean>;
  setKeepInTray(value: boolean): Promise<boolean>;
  onNavigate(fn: (route: string) => void): () => void;
}

declare global {
  interface Window {
    pulseflow?: DesktopBridge;
  }
}

export const bridge: DesktopBridge | undefined = typeof window !== 'undefined' ? window.pulseflow : undefined;

const TOKEN_KEY = 'pulseflow.token';
let token: string | null = null;
let desktopInfo: Awaited<ReturnType<DesktopBridge['connection']>> | null = null;

/** Resolves the bearer token: desktop via IPC, browser via the one-time `#token=` link printed by `pulseflow serve`. */
export async function initConnection(): Promise<void> {
  if (bridge) {
    desktopInfo = await bridge.connection();
    token = desktopInfo.token;
    return;
  }
  const m = /^#token=([A-Za-z0-9_-]+)/.exec(window.location.hash);
  if (m?.[1]) {
    sessionStorage.setItem(TOKEN_KEY, m[1]);
    history.replaceState(null, '', `${window.location.pathname}#/`);
  }
  token = sessionStorage.getItem(TOKEN_KEY);
}

export function setSessionToken(t: string | null): void {
  token = t;
  if (t) sessionStorage.setItem(TOKEN_KEY, t);
  else sessionStorage.removeItem(TOKEN_KEY);
}

export const hasToken = () => !!token;
export const getDesktopInfo = () => desktopInfo;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(url, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? 'HTTP_ERROR', err?.message ?? `Request failed (${res.status})`, err?.details);
  }
  return data as T;
}

const get = <T>(url: string) => request<T>('GET', url);
const post = <T>(url: string, body: unknown = {}) => request<T>('POST', url, body);
const qs = (o: Record<string, string | number | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

export type WorkflowListItem = Omit<Workflow, 'draft'> & { nodeCount: number; lastExecution: Execution | null };
export type ExecutionDetail = Execution & { steps: ExecutionStep[]; graph: WorkflowGraph };
export type AppInfoFull = AppInfo & { needsSetup: boolean; fixtures: boolean };
export interface AppSettings {
  advancedNodes: boolean;
  envAllowList: string[];
  retentionDays: number;
  keepRunningInTray: boolean;
}
export interface TriggerStatus {
  nodeId: string;
  kind: string;
  lastCheckAt: string | null;
  lastFiredAt: string | null;
  lastError: string | null;
  nextRunAt?: string | null;
  webhookUrl?: string;
}
export interface PlannedTemplate {
  id: string;
  name: string;
  description: string;
  status: 'planned';
  reason: string;
}
export interface NotificationRow {
  id: string;
  ts: string;
  title: string;
  body: string;
  workflow_id: string | null;
  execution_id: string | null;
  read: number;
}
export interface DeadLetter {
  id: string;
  workflow_id: string;
  execution_id: string | null;
  reason: string;
  payload: unknown;
  created_at: string;
}
export interface Principal {
  userId: string;
  name: string;
  role: 'viewer' | 'editor' | 'admin' | 'owner';
}

export const api = {
  info: () => get<AppInfoFull>('/api/app/info'),
  me: () => get<Principal | null>('/api/auth/me'),
  login: (email: string, password: string) => post<{ token: string }>('/api/auth/login', { email, password }),
  setup: (b: { email: string; password: string; name: string }) => post<{ token: string }>('/api/auth/setup', b),
  logout: () => post('/api/auth/logout'),

  nodes: () => get<NodeCatalogEntry[]>('/api/nodes'),
  credentialTypes: () => get<CredentialTypeDef[]>('/api/credential-types'),
  credentials: () => get<CredentialMeta[]>('/api/credentials'),
  createCredential: (b: { name: string; type: string; data: Record<string, string> }) => post<CredentialMeta>('/api/credentials', b),
  updateCredential: (id: string, b: { name?: string; data?: Record<string, string> }) => request<CredentialMeta>('PATCH', `/api/credentials/${id}`, b),
  deleteCredential: (id: string) => request('DELETE', `/api/credentials/${id}`),

  workflows: (search?: string) => get<WorkflowListItem[]>(`/api/workflows${qs({ search })}`),
  workflow: (id: string) => get<Workflow>(`/api/workflows/${id}`),
  createWorkflow: (b: { name: string; description?: string; draft?: WorkflowGraph }) => post<Workflow>('/api/workflows', b),
  updateWorkflow: (id: string, patch: WorkflowPatch) => request<Workflow>('PATCH', `/api/workflows/${id}`, patch),
  deleteWorkflow: (id: string) => request('DELETE', `/api/workflows/${id}`),
  duplicateWorkflow: (id: string) => post<Workflow>(`/api/workflows/${id}/duplicate`),
  validate: (id: string, graph: WorkflowGraph) => post<ValidationResult>(`/api/workflows/${id}/validate`, { graph }),
  publish: (id: string, note: string) => post<WorkflowVersion>(`/api/workflows/${id}/publish`, { note }),
  activate: (id: string) => post<Workflow>(`/api/workflows/${id}/activate`),
  deactivate: (id: string) => post<Workflow>(`/api/workflows/${id}/deactivate`),
  versions: (id: string) => get<WorkflowVersion[]>(`/api/workflows/${id}/versions`),
  restore: (id: string, versionId: string) => post<Workflow>(`/api/workflows/${id}/versions/${versionId}/restore`),
  setPermissions: (id: string, grants: Omit<PermissionGrants, 'confirmedAt'>) => request<Workflow>('PUT', `/api/workflows/${id}/permissions`, grants),
  triggers: (id: string) => get<TriggerStatus[]>(`/api/workflows/${id}/triggers`),
  rotateWebhook: (id: string, nodeId: string) => post(`/api/workflows/${id}/webhooks/${nodeId}/rotate`),
  run: (id: string, b: { triggerNodeId?: string; payload?: Record<string, unknown>; useDraft?: boolean; pinned?: Record<string, { json: Record<string, unknown> }[]> } = {}) =>
    post<{ executionId: string; state: string }>(`/api/workflows/${id}/run`, b),

  executions: (q: { workflowId?: string; state?: string; search?: string; limit?: number; before?: string } = {}) => get<Execution[]>(`/api/executions${qs(q)}`),
  executionStats: (workflowId?: string) => get<Record<string, number>>(`/api/executions/stats${qs({ workflowId })}`),
  execution: (id: string) => get<ExecutionDetail>(`/api/executions/${id}`),
  cancel: (id: string) => post(`/api/executions/${id}/cancel`),
  retry: (id: string, from: 'start' | 'failed') => post<{ executionId: string }>(`/api/executions/${id}/retry`, { from }),

  templates: () => get<{ templates: TemplateSummary[]; planned: PlannedTemplate[] }>('/api/templates'),
  template: (id: string) => get<Omit<TemplateManifest, 'fixtures'> & { fixtures: string[] }>(`/api/templates/${id}`),
  instantiate: (id: string, b: { demo: boolean; name?: string; variables?: Record<string, string | number | boolean> }) =>
    post<{ workflow: Workflow; templateDir: string }>(`/api/templates/${id}/instantiate`, b),

  exportBundle: (ids: string[]) => post<unknown>('/api/export', { ids }),
  importBundle: (bundle: unknown) => post<{ workflows: Workflow[]; issues: Record<string, unknown[]> }>('/api/import', bundle),

  notifications: () => get<NotificationRow[]>('/api/notifications'),
  markNotificationsRead: () => post('/api/notifications/read'),
  deadLetters: () => get<DeadLetter[]>('/api/dead-letters'),
  replayDeadLetter: (id: string) => post<{ executionId: string }>(`/api/dead-letters/${id}/replay`),
  deleteDeadLetter: (id: string) => request('DELETE', `/api/dead-letters/${id}`),
  settings: () => get<AppSettings>('/api/settings'),
  updateSettings: (b: Partial<AppSettings>) => request<AppSettings>('PATCH', '/api/settings', b),
  backup: () => post<{ file: string }>('/api/backup'),
};

/** Live engine events over SSE (EventSource cannot send headers, so the token goes in the query). */
export function subscribeEvents(fn: (e: EngineEvent) => void, onStatus?: (connected: boolean) => void): () => void {
  let es: EventSource | null = null;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const open = () => {
    es = new EventSource(`/api/events${token ? `?access_token=${encodeURIComponent(token)}` : ''}`);
    es.onopen = () => onStatus?.(true);
    es.onerror = () => {
      onStatus?.(false);
      es?.close();
      if (!closed) retry = setTimeout(open, 2000);
    };
    for (const type of ['execution.updated', 'step.updated', 'step.log', 'notification', 'workflow.updated']) {
      es.addEventListener(type, (ev) => fn(JSON.parse((ev as MessageEvent<string>).data) as EngineEvent));
    }
  };
  open();
  return () => {
    closed = true;
    clearTimeout(retry);
    es?.close();
  };
}
