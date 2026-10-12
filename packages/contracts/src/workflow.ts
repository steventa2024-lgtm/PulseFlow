import { z } from 'zod';

export const WORKFLOW_SCHEMA_VERSION = 1;

const idPattern = /^[A-Za-z0-9_-]{1,64}$/;
export const EntityIdSchema = z.string().regex(idPattern, 'IDs may contain letters, digits, "_" and "-" (max 64)');

export const PositionSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});

export const RetryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).max(20),
  initialDelayMs: z.number().int().min(0).max(3_600_000),
  maxDelayMs: z.number().int().min(0).max(86_400_000),
  multiplier: z.number().min(1).max(10),
  jitter: z.boolean(),
});
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 1,
  initialDelayMs: 1000,
  maxDelayMs: 60_000,
  multiplier: 2,
  jitter: true,
};

export const OnErrorSchema = z.enum(['stop', 'continue', 'route']);
export type OnErrorPolicy = z.infer<typeof OnErrorSchema>;

export const NodeInstanceSchema = z.object({
  id: EntityIdSchema,
  type: z.string().regex(/^[a-z0-9]+(\.[A-Za-z0-9-]+)+$/, 'Node type must look like "core.set"'),
  typeVersion: z.number().int().min(1).default(1),
  name: z.string().min(1).max(120),
  position: PositionSchema,
  parameters: z.record(z.string(), z.unknown()).default({}),
  credentials: z.record(z.string(), EntityIdSchema).optional(),
  disabled: z.boolean().optional(),
  notes: z.string().max(5000).optional(),
  retry: RetryPolicySchema.partial().optional(),
  timeoutMs: z.number().int().min(1).max(86_400_000).optional(),
  onError: OnErrorSchema.optional(),
});
export type NodeInstance = z.infer<typeof NodeInstanceSchema>;

export const EdgeSchema = z.object({
  id: EntityIdSchema,
  source: EntityIdSchema,
  sourcePort: z.string().min(1).max(64).default('main'),
  target: EntityIdSchema,
  targetPort: z.string().min(1).max(64).default('main'),
});
export type Edge = z.infer<typeof EdgeSchema>;

export const WorkflowGraphSchema = z.object({
  schemaVersion: z.literal(WORKFLOW_SCHEMA_VERSION).default(WORKFLOW_SCHEMA_VERSION),
  nodes: z.array(NodeInstanceSchema).max(5000),
  edges: z.array(EdgeSchema).max(20000),
});
export type WorkflowGraph = z.infer<typeof WorkflowGraphSchema>;

export const FsGrantSchema = z.object({
  path: z.string().min(1).max(4096),
  access: z.enum(['read', 'readwrite']),
});
export type FsGrant = z.infer<typeof FsGrantSchema>;

/**
 * Permissions a user has explicitly granted to a workflow. Imports always reset these
 * to the defaults, so a shared workflow file can never grant itself access.
 */
export const PermissionGrantsSchema = z.object({
  fs: z.array(FsGrantSchema).max(100).default([]),
  allowPrivateNetwork: z.boolean().default(false),
  notifications: z.boolean().default(true),
  email: z.boolean().default(false),
  advancedNodes: z.boolean().default(false),
  confirmedAt: z.string().optional(),
});
export type PermissionGrants = z.infer<typeof PermissionGrantsSchema>;

export const VariableValueSchema = z.union([z.string().max(10_000), z.number(), z.boolean()]);
export type VariableValue = z.infer<typeof VariableValueSchema>;

export const WorkflowSettingsSchema = z.object({
  timezone: z.string().min(1).max(64).default('UTC'),
  maxConcurrentRuns: z.number().int().min(1).max(64).default(1),
  maxParallelNodes: z.number().int().min(1).max(32).default(2),
  executionTimeoutMs: z.number().int().min(1000).max(7 * 86_400_000).default(30 * 60_000),
  maxItemsPerNode: z.number().int().min(1).max(1_000_000).default(100_000),
  errorWorkflowId: EntityIdSchema.optional(),
  saveExecutionData: z.enum(['all', 'errors', 'none']).default('all'),
  variables: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), VariableValueSchema).default({}),
  permissions: PermissionGrantsSchema.default({
    fs: [],
    allowPrivateNetwork: false,
    notifications: true,
    email: false,
    advancedNodes: false,
  }),
});
export type WorkflowSettings = z.infer<typeof WorkflowSettingsSchema>;

export function defaultWorkflowSettings(): WorkflowSettings {
  return WorkflowSettingsSchema.parse({});
}

export function emptyGraph(): WorkflowGraph {
  return { schemaVersion: WORKFLOW_SCHEMA_VERSION, nodes: [], edges: [] };
}

export interface Workflow {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  tags: string[];
  active: boolean;
  publishedVersionId: string | null;
  draft: WorkflowGraph;
  settings: WorkflowSettings;
  draftRevision: number;
  templateId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowVersion {
  id: string;
  workflowId: string;
  versionNumber: number;
  graph: WorkflowGraph;
  settings: WorkflowSettings;
  checksum: string;
  note: string;
  createdBy: string;
  createdAt: string;
  published: boolean;
}

export const WorkflowCreateSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(5000).default(''),
  tags: z.array(z.string().min(1).max(40)).max(30).default([]),
  draft: WorkflowGraphSchema.optional(),
  settings: WorkflowSettingsSchema.partial().optional(),
});

/** Every field optional and *without* defaults, so a patch never resets settings it does not mention. */
export const SettingsPatchSchema = z.object({
  timezone: z.string().min(1).max(64).optional(),
  maxConcurrentRuns: z.number().int().min(1).max(64).optional(),
  maxParallelNodes: z.number().int().min(1).max(32).optional(),
  executionTimeoutMs: z.number().int().min(1000).max(7 * 86_400_000).optional(),
  maxItemsPerNode: z.number().int().min(1).max(1_000_000).optional(),
  errorWorkflowId: EntityIdSchema.optional(),
  saveExecutionData: z.enum(['all', 'errors', 'none']).optional(),
  variables: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), VariableValueSchema).optional(),
});

export const WorkflowPatchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).optional(),
  tags: z.array(z.string().min(1).max(40)).max(30).optional(),
  draft: WorkflowGraphSchema.optional(),
  settings: SettingsPatchSchema.optional(),
  /** Optimistic concurrency guard: reject if the stored revision differs. */
  baseRevision: z.number().int().min(0).optional(),
});
export type WorkflowPatch = z.infer<typeof WorkflowPatchSchema>;
