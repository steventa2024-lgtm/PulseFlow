import type {
  ExecutionMode,
  Item,
  NodeInstance,
  NodeManifest,
  StepLog,
  ValidationIssue,
  WorkflowSettings,
} from '@pulseflow/contracts';
import type { Clock } from './clock';
import type { HttpClient } from './services/http';
import type { ScopedFs } from './services/fs';

export type NodeOutput = Record<string, Item[]>;

export interface KvStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<{ key: string; value: unknown }[]>;
}

export interface DedupeStore {
  /** Returns true if `key` was already recorded in `scope`; records it otherwise. */
  checkAndRecord(scope: string, key: string): Promise<boolean>;
  has(scope: string, key: string): Promise<boolean>;
}

export interface Notification {
  title: string;
  body: string;
}

export interface EmailMessage {
  credentialId: string;
  from: string;
  to: string[];
  subject: string;
  text: string;
  html?: string;
}

export interface CredentialData {
  id: string;
  type: string;
  data: Record<string, string>;
}

export interface NodeServices {
  fs: ScopedFs;
  http: HttpClient;
  kv: KvStore;
  dedupe: DedupeStore;
  notify(n: Notification): Promise<void>;
  getCredential(id: string): Promise<CredentialData>;
  runSubworkflow(workflowId: string, items: Item[], options: { depth: number; parentExecutionId: string }): Promise<Item[]>;
  sendEmail?(msg: EmailMessage): Promise<{ messageId: string; accepted: string[] }>;
  app: { demoDir: string; dataDir: string; fixturesUrl: string };
  /** Host-level switch (Settings → Advanced). Workflows must also be granted `advancedNodes`. */
  advancedNodesEnabled: boolean;
  /** Only environment variables on the user's allow-list are present. */
  env: Record<string, string>;
}

export interface NodeExecutionContext {
  executionId: string;
  workflowId: string;
  workflowName: string;
  node: NodeInstance;
  mode: ExecutionMode;
  attempt: number;
  depth: number;
  /** All input items concatenated across input ports (convenience for single-input nodes). */
  items: Item[];
  inputs: Record<string, Item[]>;
  triggerItems: Item[];
  settings: WorkflowSettings;
  signal: AbortSignal;
  clock: Clock;
  services: NodeServices;
  /** Set when a durable Wait node is resumed. */
  resumeAt?: Date;
  /** Raw (unresolved) parameter value. */
  rawParam(name: string): unknown;
  /** Parameter resolved with expressions evaluated against item `itemIndex`. */
  param<T = unknown>(name: string, itemIndex?: number): T;
  /** Resolve an arbitrary template string against an item. */
  evaluate(template: string, itemIndex?: number, extraRoots?: Record<string, unknown>): unknown;
  log(level: StepLog['level'], message: string): void;
}

export interface NodeDefinition {
  manifest: NodeManifest;
  /** Extra static validation beyond the generic parameter checks. */
  validate?(node: NodeInstance): ValidationIssue[];
  execute(ctx: NodeExecutionContext): Promise<NodeOutput>;
}

export class NodeRegistry {
  readonly #defs = new Map<string, NodeDefinition>();

  register(def: NodeDefinition): this {
    if (this.#defs.has(def.manifest.type)) throw new Error(`Node type already registered: ${def.manifest.type}`);
    this.#defs.set(def.manifest.type, def);
    return this;
  }

  registerAll(defs: NodeDefinition[]): this {
    for (const d of defs) this.register(d);
    return this;
  }

  get(type: string): NodeDefinition | undefined {
    return this.#defs.get(type);
  }

  has(type: string): boolean {
    return this.#defs.has(type);
  }

  list(): NodeDefinition[] {
    return [...this.#defs.values()];
  }

  manifests(): NodeManifest[] {
    return this.list().map((d) => d.manifest);
  }
}
