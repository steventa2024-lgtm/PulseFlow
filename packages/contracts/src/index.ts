import { z } from "zod";

export const ENGINE_VERSION = "0.1.0";
export const GRAPH_SCHEMA_VERSION = 1 as const;
export const BUNDLE_KIND = "pulseflow.bundle" as const;

export const EXECUTION_STATES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "waiting",
  "retrying",
  "skipped",
] as const;

export type ExecutionState = (typeof EXECUTION_STATES)[number];

export const STEP_STATES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "retrying",
  "skipped",
  "waiting",
] as const;

export type StepState = (typeof STEP_STATES)[number];

export const PERMISSIONS = [
  "workflow.read",
  "workflow.write",
  "workflow.run",
  "workflow.publish",
  "credential.read",
  "credential.write",
  "audit.read",
  "admin",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const NODE_CATEGORIES = [
  "trigger",
  "logic",
  "action",
  "data",
  "files",
  "network",
  "connector",
  "developer",
  "ai",
] as const;

export type NodeCategory = (typeof NODE_CATEGORIES)[number];

const forbiddenKey = (key: string) =>
  key === "__proto__" || key === "constructor" || key === "prototype";

export function sanitizeUnknown(value: unknown, depth = 0): unknown {
  if (depth > 40) {
    throw new Error("JSON exceeds the maximum nesting depth");
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    if (value.length > 100_000) throw new Error("JSON array is too large");
    return value.map((entry) => sanitizeUnknown(entry, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (forbiddenKey(key)) continue;
    out[key] = sanitizeUnknown(entry, depth + 1);
  }
  return out;
}

export function createId(prefix: string): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${hex}`;
}

export class FlowError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(message: string, code: string, retryable = false, retryAfterMs?: number) {
    super(message);
    this.name = "FlowError";
    this.code = code;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

export function isFlowError(error: unknown): error is FlowError {
  return error instanceof FlowError;
}

export interface Item {
  json: Record<string, unknown>;
}

export interface NodeResult {
  items: Item[];
  port: string;
  ports: Record<string, Item[]>;
  waitMs?: number;
  logs?: Array<{ level: "debug" | "info" | "warn" | "error"; message: string; data?: unknown }>;
}

export const positionSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});

export const retrySchema = z.object({
  maxAttempts: z.number().int().min(1).max(10),
  backoffMs: z.number().int().min(0).max(3_600_000),
  jitter: z.boolean(),
  maxBackoffMs: z.number().int().min(0).max(3_600_000).optional(),
});

export type RetryPolicy = z.infer<typeof retrySchema>;

export const graphNodeSchema = z.object({
  id: z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/),
  manifestId: z.string().min(1).max(120),
  manifestVersion: z.string().min(1).max(40),
  position: positionSchema,
  parameters: z.record(z.string(), z.unknown()),
  credentialRef: z.string().min(1).max(80).optional(),
  disabled: z.boolean().optional(),
  notes: z.string().max(4000).optional(),
  name: z.string().max(120).optional(),
  retry: retrySchema.optional(),
  timeoutMs: z.number().int().min(1).max(3_600_000).optional(),
  continueOnError: z.boolean().optional(),
  required: z.boolean().optional(),
});

export type GraphNode = z.infer<typeof graphNodeSchema>;

export const graphEdgeSchema = z.object({
  id: z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/),
  source: z.string().min(1).max(80),
  sourcePort: z.string().min(1).max(40),
  target: z.string().min(1).max(80),
  targetPort: z.string().min(1).max(40),
  label: z.string().max(80).optional(),
});

export type GraphEdge = z.infer<typeof graphEdgeSchema>;

export const graphMetaSchema = z.object({
  templateId: z.string().max(40).optional(),
  tier: z.enum(["A", "B", "custom"]).optional(),
  description: z.string().max(4000).optional(),
  category: z.string().max(80).optional(),
  difficulty: z.enum(["beginner", "intermediate", "advanced"]).optional(),
  needsFixture: z.boolean().optional(),
  needsSmtp: z.boolean().optional(),
  credentialKind: z.string().max(40).optional(),
  permissions: z.array(z.string().max(80)).max(30).optional(),
  services: z.array(z.string().max(80)).max(30).optional(),
});

export type GraphMeta = z.infer<typeof graphMetaSchema>;

export const workflowGraphSchema = z.object({
  schemaVersion: z.literal(GRAPH_SCHEMA_VERSION),
  nodes: z.array(graphNodeSchema).max(2000),
  edges: z.array(graphEdgeSchema).max(4000),
  settings: z
    .object({
      concurrency: z.number().int().min(1).max(32).optional(),
      timeoutMs: z.number().int().min(1).max(86_400_000).optional(),
      timezone: z.string().max(80).optional(),
      interruptPolicy: z.enum(["fail", "requeue"]).optional(),
      maxIterations: z.number().int().min(1).max(10_000).optional(),
      allowShell: z.boolean().optional(),
    })
    .optional(),
  meta: graphMetaSchema.optional(),
});

export type WorkflowGraph = z.infer<typeof workflowGraphSchema>;

export const fieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum([
    "string",
    "number",
    "boolean",
    "json",
    "select",
    "text",
    "path",
    "expression",
    "credential",
  ]),
  required: z.boolean().optional(),
  default: z.unknown().optional(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  help: z.string().optional(),
  secret: z.boolean().optional(),
  placeholder: z.string().optional(),
});

export type FieldSchema = z.infer<typeof fieldSchema>;

export const portSchema = z.object({
  id: z.string(),
  label: z.string().optional(),
});

export type PortSchema = z.infer<typeof portSchema>;

export const manifestSchema = z.object({
  id: z.string(),
  version: z.string(),
  title: z.string(),
  description: z.string(),
  category: z.enum(NODE_CATEGORIES),
  icon: z.string(),
  inputs: z.array(portSchema),
  outputs: z.array(portSchema),
  fields: z.array(fieldSchema),
  permissions: z.array(z.string()),
  dangerous: z.boolean().optional(),
  fanIn: z.enum(["all", "any"]).optional(),
  docs: z.string().optional(),
});

export type NodeManifest = z.infer<typeof manifestSchema>;

export interface ValidationIssue {
  level: "error" | "warning";
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
}

export interface TemplateInfo {
  id: string;
  tier: "A" | "B";
  name: string;
  description: string;
  category: string;
  difficulty: "beginner" | "intermediate" | "advanced";
  trigger: string;
  permissions: string[];
  services: string[];
  setupMinutes: number;
  offline: boolean;
  credentialKind?: string;
  docs: string;
  graph: WorkflowGraph;
}

export const bundleSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal(BUNDLE_KIND),
  exportedAt: z.string(),
  generator: z.string().optional(),
  workflows: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        description: z.string().max(4000).optional(),
        tags: z.array(z.string().max(40)).max(30).optional(),
        timezone: z.string().max(80).optional(),
        graph: workflowGraphSchema,
      }),
    )
    .max(500),
});

export type WorkflowBundle = z.infer<typeof bundleSchema>;

export function parseBundle(input: unknown): WorkflowBundle {
  const clean = sanitizeUnknown(input);
  const parsed = bundleSchema.safeParse(clean);
  if (!parsed.success) {
    throw new FlowError(parsed.error.issues.map((issue) => issue.message).join("; "), "INVALID_BUNDLE");
  }
  return parsed.data;
}

export function parseGraph(input: unknown): WorkflowGraph {
  const clean = sanitizeUnknown(input);
  const parsed = workflowGraphSchema.safeParse(clean);
  if (!parsed.success) {
    throw new FlowError(parsed.error.issues.map((issue) => issue.message).join("; "), "INVALID_GRAPH");
  }
  return parsed.data;
}

export function emptyGraph(): WorkflowGraph {
  return {
    schemaVersion: 1,
    nodes: [
      {
        id: "manual",
        manifestId: "trigger.manual",
        manifestVersion: "1.0.0",
        position: { x: 80, y: 160 },
        parameters: { payload: { name: "PulseFlow" } },
        name: "Manual",
      },
    ],
    edges: [],
    settings: { concurrency: 1, interruptPolicy: "fail", timezone: "UTC" },
  };
}

export function defaultRetry(): RetryPolicy {
  return { maxAttempts: 1, backoffMs: 200, jitter: false, maxBackoffMs: 30_000 };
}

export function toItems(payload: unknown): Item[] {
  if (payload === undefined || payload === null) return [{ json: {} }];
  if (Array.isArray(payload)) {
    return payload.map((entry) => {
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        return { json: entry as Record<string, unknown> };
      }
      return { json: { value: entry as string | number | boolean | null } };
    });
  }
  if (typeof payload === "object") return [{ json: payload as Record<string, unknown> }];
  return [{ json: { value: payload as string | number | boolean } }];
}

export function isTruthy(value: unknown): boolean {
  if (value === false || value === null || value === undefined) return false;
  if (typeof value === "string" && value.length === 0) return false;
  if (typeof value === "number" && value === 0) return false;
  return true;
}
