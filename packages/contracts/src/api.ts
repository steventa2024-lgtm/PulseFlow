import { z } from 'zod';
import type { NodeManifest } from './nodes';

export const API_VERSION = 'v1';
export const ENGINE_VERSION = '0.1.0';

export interface ValidationIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
  param?: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export const RunRequestSchema = z.object({
  triggerNodeId: z.string().optional(),
  items: z.array(z.object({ json: z.record(z.string(), z.unknown()) })).max(10_000).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  /** Run the current draft instead of the published version. */
  useDraft: z.boolean().default(true),
  /** Pinned node outputs for debugging (never applied to trigger-mode runs). */
  pinned: z.record(z.string(), z.array(z.object({ json: z.record(z.string(), z.unknown()) }))).optional(),
  wait: z.boolean().default(false),
});
export type RunRequest = z.infer<typeof RunRequestSchema>;

export const CredentialCreateSchema = z.object({
  name: z.string().min(1).max(200),
  type: z.string().min(1).max(64),
  data: z.record(z.string(), z.string().max(20_000)),
});

export interface CredentialMeta {
  id: string;
  name: string;
  type: string;
  fields: string[];
  createdAt: string;
  updatedAt: string;
  lastCheckedAt: string | null;
  lastCheckOk: boolean | null;
}

export interface CredentialTypeDef {
  type: string;
  displayName: string;
  fields: { name: string; label: string; secret: boolean; required: boolean; placeholder?: string }[];
  docsUrl?: string;
}

export interface NodeCatalogEntry extends NodeManifest {
  enabled: boolean;
  disabledReason?: string;
}

export interface AppInfo {
  name: string;
  version: string;
  engineVersion: string;
  mode: 'local' | 'server';
  dataDir: string;
  demoDir: string;
  fixturesUrl: string;
  platform: string;
  telemetry: false;
}

export interface AuditEvent {
  id: string;
  ts: string;
  actor: string;
  action: string;
  target: string;
  details: Record<string, unknown>;
}
