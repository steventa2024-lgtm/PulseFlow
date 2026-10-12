import type { GraphNode, Item, NodeManifest, NodeResult } from "@pulseflow/contracts";
import type { SsrfPolicy } from "@pulseflow/security";

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
}

export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface NodeContext {
  node: GraphNode;
  items: Item[];
  rawParameters: Record<string, unknown>;
  execution: {
    id: string;
    workflowId: string;
    workspaceId: string;
    mode: string;
    payload: unknown;
    depth: number;
  };
  attempt: number;
  signal: AbortSignal;
  clock: Clock;
  paths: { home: string; demo: string; inbox: string; out: string; backup: string };
  services: Record<string, unknown>;
  permissions: {
    roots: string[];
    allowNetwork: boolean;
    allowShell: boolean;
    ssrf: SsrfPolicy;
  };
  log: (level: "debug" | "info" | "warn" | "error", message: string, data?: unknown) => void;
  eval: (expression: string, item: Item, index: number) => unknown;
  interpolate: (value: unknown, item: Item, index: number) => unknown;
  getOutput: (nodeId: string) => Item[] | undefined;
  kv: {
    get(namespace: string, key: string): unknown;
    set(namespace: string, key: string, value: unknown): void;
  };
  secrets: { get(id: string): unknown };
  notify: (notice: { title: string; body: string }) => void;
  http: (request: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  }) => Promise<HttpResponse>;
  respond?: (response: { status: number; body: unknown; headers?: Record<string, string> }) => void;
  runSubworkflow: (workflowId: string, items: Item[], depth: number) => Promise<Item[]>;
  recordDelivery: (status: string, detail?: string) => void;
}

export interface NodeDefinition {
  manifest: NodeManifest;
  execute(ctx: NodeContext): Promise<NodeResult>;
}

export function single(port: string, json: Record<string, unknown>, logs?: NodeResult["logs"]): NodeResult {
  const items = [{ json }];
  return { port, items, ports: { [port]: items }, logs };
}

export function fromItems(port: string, items: Item[]): NodeResult {
  return { port, items, ports: { [port]: items } };
}

export function multi(ports: Record<string, Item[]>, primary: string): NodeResult {
  return { port: primary, items: ports[primary] ?? [], ports };
}

export function firstItem(ctx: NodeContext): Item {
  return ctx.items[0] ?? { json: {} };
}

export function readParam(ctx: NodeContext, key: string, fallback?: unknown): unknown {
  const item = firstItem(ctx);
  const raw = ctx.rawParameters[key] === undefined ? fallback : ctx.rawParameters[key];
  return ctx.interpolate(raw, item, 0);
}

export function readString(ctx: NodeContext, key: string, fallback = ""): string {
  const value = readParam(ctx, key, fallback);
  return value === undefined || value === null ? fallback : String(value);
}

export function readNumber(ctx: NodeContext, key: string, fallback: number): number {
  const value = readParam(ctx, key, fallback);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function readBoolean(ctx: NodeContext, key: string, fallback = false): boolean {
  const value = readParam(ctx, key, fallback);
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}
