import fs from 'node:fs';
import path from 'node:path';
import {
  BUNDLE_FORMAT,
  BUNDLE_FORMAT_VERSION,
  WorkflowBundleSchema,
  WorkflowSettingsSchema,
  defaultWorkflowSettings,
  emptyGraph,
  newId,
  type FsGrant,
  type Item,
  type PermissionGrants,
  type RunRequest,
  type TemplateManifest,
  type ValidationResult,
  type VariableValue,
  type Workflow,
  type WorkflowBundle,
  type WorkflowGraph,
  type WorkflowPatch,
  type WorkflowSettings,
  type WorkflowVersion,
} from '@pulseflow/contracts';
import { validateGraph, type Clock, type NodeRegistry } from '@pulseflow/engine';
import { isWithin, redact, sanitizeFileName, sha256Hex } from '@pulseflow/security';
import { graphChecksum, type ExecutionRecord, type Store } from '@pulseflow/storage';
import { getTemplate, resolveTemplateVariables } from '@pulseflow/templates';
import { HttpError, type CredentialService } from './credentials';
import type { EventBus } from './events';
import type { ExecutionService } from './executions';
import type { TriggerManager } from './triggers';

export interface WorkflowServiceDeps {
  store: Store;
  registry: NodeRegistry;
  clock: Clock;
  bus: EventBus;
  executions: ExecutionService;
  triggers: TriggerManager;
  credentials: CredentialService;
  workspaceId: string;
  app: { name: string; version: string; demoDir: string; fixturesUrl: () => string };
}

export interface InstantiateOptions {
  demo?: boolean;
  variables?: Record<string, VariableValue>;
  name?: string;
}

const MANUAL_TRIGGER = 'core.manualTrigger';

export class WorkflowService {
  constructor(private readonly deps: WorkflowServiceDeps) {}

  #emitUpdated(wf: Workflow): void {
    this.deps.bus.emit({ type: 'workflow.updated', workflowId: wf.id, ts: this.deps.clock.now().toISOString() });
  }

  list(opts: { search?: string; active?: boolean } = {}): Workflow[] {
    return this.deps.store.workflows.list(this.deps.workspaceId, opts);
  }

  get(id: string): Workflow {
    const wf = this.deps.store.workflows.get(id);
    if (!wf || wf.workspaceId !== this.deps.workspaceId) throw new HttpError(404, 'NOT_FOUND', 'Workflow not found');
    return wf;
  }

  create(input: { name: string; description?: string; tags?: string[]; draft?: WorkflowGraph; settings?: Partial<WorkflowSettings>; templateId?: string | null }, actor: string): Workflow {
    const settings = WorkflowSettingsSchema.parse({ ...input.settings, permissions: input.settings?.permissions ?? defaultWorkflowSettings().permissions });
    const wf = this.deps.store.workflows.create({
      workspaceId: this.deps.workspaceId,
      name: input.name,
      description: input.description ?? '',
      tags: input.tags ?? [],
      draft: input.draft ?? emptyGraph(),
      settings,
      templateId: input.templateId ?? null,
    });
    this.deps.store.audit.record(actor, 'workflow.create', wf.id, { name: wf.name, templateId: wf.templateId });
    this.#emitUpdated(wf);
    return wf;
  }

  update(id: string, patch: WorkflowPatch, actor: string): Workflow {
    const current = this.get(id);
    const settings = patch.settings ? WorkflowSettingsSchema.parse({ ...current.settings, ...patch.settings, permissions: current.settings.permissions }) : undefined;
    try {
      const wf = this.deps.store.workflows.update(
        id,
        {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.description !== undefined ? { description: patch.description } : {}),
          ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
          ...(patch.draft !== undefined ? { draft: patch.draft } : {}),
          ...(settings ? { settings } : {}),
        },
        patch.baseRevision,
      );
      this.deps.store.audit.record(actor, 'workflow.update', id, { revision: wf.draftRevision });
      this.#emitUpdated(wf);
      return wf;
    } catch (e) {
      if ((e as { code?: string }).code === 'REVISION_CONFLICT') throw new HttpError(409, 'REVISION_CONFLICT', (e as Error).message);
      throw e;
    }
  }

  delete(id: string, actor: string): void {
    const wf = this.get(id);
    this.deps.triggers.deactivate(id);
    this.deps.store.schedules.deleteForWorkflow(id);
    this.deps.store.kv.deleteNamespace(`wf:${id}`);
    this.deps.store.kv.deleteNamespace(`trigger:${id}:`);
    this.deps.store.workflows.delete(id);
    this.deps.store.audit.record(actor, 'workflow.delete', id, { name: wf.name });
  }

  duplicate(id: string, actor: string): Workflow {
    const wf = this.get(id);
    return this.create({ name: `${wf.name} (copy)`, description: wf.description, tags: wf.tags, draft: wf.draft, settings: { ...wf.settings, permissions: defaultWorkflowSettings().permissions } }, actor);
  }

  validate(graph: WorkflowGraph): ValidationResult {
    return validateGraph(graph, this.deps.registry, { requireTrigger: true });
  }

  /** Snapshots the draft as an immutable version. Blocks on validation errors. */
  publish(id: string, note: string, actor: string): WorkflowVersion {
    const wf = this.get(id);
    const result = this.validate(wf.draft);
    if (!result.ok) throw new HttpError(422, 'WORKFLOW_INVALID', 'Fix validation errors before publishing', result.issues);
    const version = this.deps.store.versions.create({ workflowId: id, graph: wf.draft, settings: wf.settings, note: note || 'Published', createdBy: actor, published: true });
    this.deps.store.workflows.setPublishedVersion(id, version.id);
    this.deps.store.audit.record(actor, 'workflow.publish', id, { version: version.versionNumber, checksum: version.checksum });
    const fresh = this.get(id);
    if (fresh.active) this.deps.triggers.activate(fresh);
    this.#emitUpdated(fresh);
    return version;
  }

  /** Activation always runs the published version; unpublished draft changes are published first. */
  activate(id: string, actor: string): Workflow {
    let wf = this.get(id);
    const published = wf.publishedVersionId ? this.deps.store.versions.get(wf.publishedVersionId) : undefined;
    if (!published || published.checksum !== graphChecksum(wf.draft, wf.settings)) {
      this.publish(id, 'Published on activation', actor);
      wf = this.get(id);
    }
    const version = this.deps.store.versions.get(wf.publishedVersionId!)!;
    const hasAutoTrigger = version.graph.nodes.some((n) => !n.disabled && n.type !== MANUAL_TRIGGER && this.deps.registry.get(n.type)?.manifest.trigger);
    if (!hasAutoTrigger) throw new HttpError(422, 'NO_AUTOMATIC_TRIGGER', 'Add a schedule, webhook, watch or poll trigger to activate this workflow (manual triggers run on demand only)');
    this.deps.store.workflows.setActive(id, true);
    wf = this.get(id);
    try {
      this.deps.triggers.activate(wf);
    } catch (e) {
      this.deps.store.workflows.setActive(id, false);
      throw new HttpError(422, 'ACTIVATION_FAILED', (e as Error).message);
    }
    this.deps.store.audit.record(actor, 'workflow.activate', id, {});
    this.#emitUpdated(wf);
    return wf;
  }

  deactivate(id: string, actor: string): Workflow {
    this.get(id);
    this.deps.triggers.deactivate(id);
    this.deps.store.workflows.setActive(id, false);
    this.deps.store.audit.record(actor, 'workflow.deactivate', id, {});
    const wf = this.get(id);
    this.#emitUpdated(wf);
    return wf;
  }

  versions(id: string): WorkflowVersion[] {
    this.get(id);
    return this.deps.store.versions.list(id);
  }

  version(id: string, versionId: string): WorkflowVersion {
    const v = this.deps.store.versions.get(versionId);
    if (!v || v.workflowId !== id) throw new HttpError(404, 'NOT_FOUND', 'Version not found');
    return v;
  }

  /** Copies a version into the draft. The published version is unchanged until the user publishes. */
  restore(id: string, versionId: string, actor: string): Workflow {
    const v = this.version(id, versionId);
    const wf = this.get(id);
    const updated = this.deps.store.workflows.update(id, { draft: v.graph, settings: { ...v.settings, permissions: wf.settings.permissions } });
    this.deps.store.audit.record(actor, 'workflow.restore', id, { version: v.versionNumber });
    this.#emitUpdated(updated);
    return updated;
  }

  setPermissions(id: string, grants: PermissionGrants, actor: string): Workflow {
    const wf = this.get(id);
    const permissions = { ...grants, fs: grants.fs.map((g) => ({ path: path.resolve(g.path), access: g.access })), confirmedAt: this.deps.clock.now().toISOString() };
    const updated = this.deps.store.workflows.update(id, { settings: { ...wf.settings, permissions } });
    this.deps.store.audit.record(actor, 'workflow.permissions', id, { fs: permissions.fs, allowPrivateNetwork: permissions.allowPrivateNetwork, email: permissions.email, advancedNodes: permissions.advancedNodes });
    this.#emitUpdated(updated);
    return updated;
  }

  #pickTrigger(graph: WorkflowGraph, requested?: string): string {
    const triggers = graph.nodes.filter((n) => !n.disabled && this.deps.registry.get(n.type)?.manifest.trigger);
    if (requested) {
      if (!triggers.some((t) => t.id === requested)) throw new HttpError(400, 'INVALID_TRIGGER', 'That node is not an enabled trigger in this workflow');
      return requested;
    }
    const pick = triggers.find((t) => t.type === MANUAL_TRIGGER) ?? triggers[0];
    if (!pick) throw new HttpError(422, 'NO_TRIGGER', 'Add a trigger node (e.g. Manual Trigger) to run this workflow');
    return pick.id;
  }

  run(id: string, req: RunRequest, actor: string): ExecutionRecord {
    const wf = this.get(id);
    let graph = wf.draft;
    let settings = wf.settings;
    let versionId: string | null = null;
    if (!req.useDraft) {
      if (!wf.publishedVersionId) throw new HttpError(409, 'NOT_PUBLISHED', 'Publish the workflow first or run the draft');
      const v = this.deps.store.versions.get(wf.publishedVersionId)!;
      graph = v.graph;
      settings = { ...v.settings, permissions: wf.settings.permissions };
      versionId = v.id;
    }
    const result = this.validate(graph);
    if (!result.ok) throw new HttpError(422, 'WORKFLOW_INVALID', 'Fix validation errors before running', result.issues);
    const triggerNodeId = this.#pickTrigger(graph, req.triggerNodeId);
    const items: Item[] = req.items ?? (req.payload ? [{ json: req.payload }] : []);
    const rec = this.deps.executions.enqueue({
      workflowId: wf.id,
      workflowName: wf.name,
      versionId,
      graph,
      settings,
      triggerNodeId,
      items,
      mode: 'manual',
      pinned: req.pinned ?? null,
    });
    this.deps.store.audit.record(actor, 'workflow.run', id, { executionId: rec.id, useDraft: req.useDraft });
    return rec;
  }

  /** Bundles never contain credential values, credential references, or permission grants. */
  exportBundle(ids: string[]): WorkflowBundle {
    const secrets = this.deps.credentials.allSecretValues();
    const workflows = ids.map((id) => {
      const wf = this.get(id);
      const graph: WorkflowGraph = {
        ...wf.draft,
        nodes: wf.draft.nodes.map((n) => {
          const parameters = { ...n.parameters };
          const def = this.deps.registry.get(n.type);
          for (const p of def?.manifest.parameters ?? []) if (p.type === 'credential' && typeof parameters[p.name] === 'string' && !String(parameters[p.name]).includes('{{')) parameters[p.name] = '';
          const { credentials: _c, ...rest } = n;
          return { ...rest, parameters };
        }),
      };
      const { permissions: _p, errorWorkflowId: _e, ...settings } = wf.settings;
      return { id: wf.id, name: wf.name, description: wf.description, tags: wf.tags, graph: redact(graph, { secrets }), settings: redact(settings, { secrets }) };
    });
    const checksum = sha256Hex(JSON.stringify(workflows));
    return {
      format: BUNDLE_FORMAT,
      formatVersion: BUNDLE_FORMAT_VERSION,
      manifest: { exportedAt: this.deps.clock.now().toISOString(), app: this.deps.app.name, appVersion: this.deps.app.version, workflowCount: workflows.length, checksum },
      workflows,
    };
  }

  /** Imported workflows start inactive with default (empty) permissions and are never auto-run. */
  importBundle(raw: unknown, actor: string): { workflows: Workflow[]; issues: Record<string, ValidationResult['issues']> } {
    const parsed = WorkflowBundleSchema.safeParse(raw);
    if (!parsed.success) throw new HttpError(400, 'INVALID_BUNDLE', 'Not a valid PulseFlow bundle', parsed.error.issues.slice(0, 20));
    const bundle = parsed.data;
    if (sha256Hex(JSON.stringify(bundle.workflows)) !== bundle.manifest.checksum) throw new HttpError(400, 'CHECKSUM_MISMATCH', 'Bundle checksum does not match its contents (file corrupted or edited)');
    const created: Workflow[] = [];
    const issues: Record<string, ValidationResult['issues']> = {};
    this.deps.store.db.transaction(() => {
      for (const w of bundle.workflows) {
        const { permissions: _p, ...settings } = w.settings;
        const wf = this.create({ name: w.name, description: w.description, tags: w.tags, draft: w.graph, settings: { ...settings, permissions: defaultWorkflowSettings().permissions } }, actor);
        created.push(wf);
        const v = this.validate(w.graph);
        if (v.issues.length) issues[wf.id] = v.issues;
      }
    });
    this.deps.store.audit.record(actor, 'workflow.import', created.map((w) => w.id).join(','), { count: created.length });
    return { workflows: created, issues };
  }

  /**
   * Creates a workflow from a first-party template. Sample files are copied into an app-owned
   * folder; folder/file variables outside the demo folder get explicit filesystem grants.
   */
  instantiateTemplate(idOrSlug: string, opts: InstantiateOptions, actor: string): { workflow: Workflow; templateDir: string; template: TemplateManifest } {
    const tpl = getTemplate(idOrSlug);
    if (!tpl) throw new HttpError(404, 'NOT_FOUND', 'Template not found');
    if (opts.demo && !tpl.demoOverrides && tpl.tier === 'B') throw new HttpError(400, 'NO_DEMO', 'This template has no demo mode');
    const folder = `${tpl.id.toLowerCase()}-${tpl.slug}-${newId('t').slice(-6).toLowerCase()}`;
    const templateDir = path.join(this.deps.app.demoDir, 'templates', sanitizeFileName(folder));
    fs.mkdirSync(templateDir, { recursive: true });
    for (const [rel, content] of Object.entries(tpl.fixtures)) {
      const target = path.resolve(templateDir, rel);
      if (!isWithin(target, templateDir)) throw new Error(`Template fixture escapes its folder: ${rel}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
    for (const v of tpl.variables) {
      if (v.kind === 'folder' && typeof v.default === 'string' && v.default.startsWith('${templateDir}')) {
        fs.mkdirSync(path.resolve(templateDir, v.default.slice('${templateDir}'.length).replace(/^[\\/]/, '')), { recursive: true });
      }
    }
    const variables = resolveTemplateVariables(tpl, { demoDir: this.deps.app.demoDir, templateDir, fixturesUrl: this.deps.app.fixturesUrl() }, { demo: opts.demo === true, overrides: opts.variables ?? {} });
    const grants: FsGrant[] = [];
    for (const v of tpl.variables) {
      const value = variables[v.name];
      if (!v.access || typeof value !== 'string' || !value) continue;
      const abs = path.resolve(value);
      if (isWithin(abs, this.deps.app.demoDir)) continue;
      grants.push({ path: v.kind === 'file' && v.access === 'readwrite' ? path.dirname(abs) : abs, access: v.access });
    }
    const base = defaultWorkflowSettings();
    const tplPermissions = tpl.workflow.settings.permissions;
    const settings: WorkflowSettings = WorkflowSettingsSchema.parse({
      ...base,
      ...tpl.workflow.settings,
      timezone: tpl.workflow.settings.timezone ?? localTimezone(),
      variables,
      permissions: { ...base.permissions, ...(tplPermissions ?? {}), fs: grants, confirmedAt: this.deps.clock.now().toISOString() },
    });
    const workflow = this.create(
      {
        name: opts.name ?? `${tpl.workflow.name}${opts.demo && tpl.tier === 'B' ? ' (demo)' : ''}`,
        description: tpl.workflow.description,
        tags: [...tpl.tags, ...(opts.demo && tpl.tier === 'B' ? ['demo'] : [])],
        draft: tpl.workflow.graph,
        settings,
        templateId: tpl.id,
      },
      actor,
    );
    this.deps.store.audit.record(actor, 'template.instantiate', workflow.id, { template: tpl.id, demo: opts.demo === true, grants });
    return { workflow, templateDir, template: tpl };
  }
}

export function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
