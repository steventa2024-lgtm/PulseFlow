import {
  getNodeOutputsWithError,
  WorkflowGraphSchema,
  type ParamDef,
  type ValidationIssue,
  type ValidationResult,
  type WorkflowGraph,
} from '@pulseflow/contracts';
import { hasExpression, validateTemplateSyntax } from './expressions';
import type { NodeRegistry } from './types';

export interface CompiledGraph {
  graph: WorkflowGraph;
  order: string[];
  triggers: string[];
}

function isParamVisible(def: ParamDef, params: Record<string, unknown>, defs: ParamDef[]): boolean {
  if (!def.showIf) return true;
  const dep = defs.find((d) => d.name === def.showIf!.param);
  const value = params[def.showIf.param] ?? dep?.default;
  return def.showIf.equals.includes(value);
}

function validateExpressionsDeep(value: unknown, report: (msg: string) => void, depth = 0): void {
  if (depth > 32) return;
  if (typeof value === 'string') {
    if (value.includes('{{') || value.includes('}}')) {
      const err = validateTemplateSyntax(value);
      if (err) report(err);
    }
  } else if (Array.isArray(value)) {
    for (const v of value) validateExpressionsDeep(v, report, depth + 1);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) validateExpressionsDeep(v, report, depth + 1);
  }
}

/** Static validation used by the editor, publish, and before every run. */
export function validateGraph(
  input: unknown,
  registry: NodeRegistry,
  options: { requireTrigger?: boolean } = {},
): ValidationResult & { compiled?: CompiledGraph } {
  const issues: ValidationIssue[] = [];
  const parsed = WorkflowGraphSchema.safeParse(input);
  if (!parsed.success) {
    for (const iss of parsed.error.issues.slice(0, 50)) {
      issues.push({ severity: 'error', code: 'SCHEMA', message: `${iss.path.join('.')}: ${iss.message}` });
    }
    return { ok: false, issues };
  }
  const graph = parsed.data;
  const byId = new Map<string, (typeof graph.nodes)[number]>();
  const names = new Map<string, string>();

  for (const node of graph.nodes) {
    if (byId.has(node.id)) issues.push({ severity: 'error', code: 'DUPLICATE_NODE_ID', message: `Duplicate node id ${node.id}`, nodeId: node.id });
    byId.set(node.id, node);
    const lname = node.name.trim().toLowerCase();
    if (names.has(lname)) {
      issues.push({ severity: 'error', code: 'DUPLICATE_NODE_NAME', message: `Node names must be unique ("${node.name}")`, nodeId: node.id });
    }
    names.set(lname, node.id);

    const def = registry.get(node.type);
    if (!def) {
      issues.push({ severity: 'error', code: 'UNKNOWN_NODE_TYPE', message: `Unknown node type "${node.type}"`, nodeId: node.id });
      continue;
    }
    const m = def.manifest;
    for (const p of m.parameters) {
      if (!isParamVisible(p, node.parameters, m.parameters)) continue;
      const v = node.parameters[p.name] ?? p.default;
      const missing = v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0 && p.type !== 'keyvalue');
      if (p.required && missing) {
        issues.push({ severity: 'error', code: 'PARAM_REQUIRED', message: `${node.name}: "${p.label}" is required`, nodeId: node.id, param: p.name });
        continue;
      }
      if (missing) continue;
      if (!p.noExpression) {
        validateExpressionsDeep(v, (msg) =>
          issues.push({ severity: 'error', code: 'EXPRESSION_SYNTAX', message: `${node.name}: "${p.label}" — ${msg}`, nodeId: node.id, param: p.name }),
        );
      }
      if (hasExpression(v)) continue;
      if (p.type === 'number' && typeof v !== 'number' && !(typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)))) {
        issues.push({ severity: 'error', code: 'PARAM_TYPE', message: `${node.name}: "${p.label}" must be a number`, nodeId: node.id, param: p.name });
      } else if (typeof v === 'number' && ((p.min !== undefined && v < p.min) || (p.max !== undefined && v > p.max))) {
        issues.push({
          severity: 'error',
          code: 'PARAM_RANGE',
          message: `${node.name}: "${p.label}" must be between ${p.min ?? '-∞'} and ${p.max ?? '∞'}`,
          nodeId: node.id,
          param: p.name,
        });
      } else if (p.type === 'select' && p.options && !p.options.some((o) => o.value === v)) {
        issues.push({
          severity: 'error',
          code: 'PARAM_OPTION',
          message: `${node.name}: "${p.label}" has invalid value "${String(v)}"`,
          nodeId: node.id,
          param: p.name,
        });
      } else if (p.type === 'boolean' && typeof v !== 'boolean') {
        issues.push({ severity: 'error', code: 'PARAM_TYPE', message: `${node.name}: "${p.label}" must be true/false`, nodeId: node.id, param: p.name });
      } else if (p.type === 'credential' && p.required && !(node.credentials?.[p.name] ?? (typeof v === 'string' ? v : undefined))) {
        issues.push({ severity: 'error', code: 'CREDENTIAL_REQUIRED', message: `${node.name}: select a credential`, nodeId: node.id, param: p.name });
      }
    }
    if (def.validate) issues.push(...def.validate(node));
  }

  const outgoing = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const n of graph.nodes) {
    outgoing.set(n.id, []);
    indegree.set(n.id, 0);
  }
  const seenEdges = new Set<string>();
  for (const e of graph.edges) {
    const src = byId.get(e.source);
    const tgt = byId.get(e.target);
    if (!src || !tgt) {
      issues.push({ severity: 'error', code: 'DANGLING_EDGE', message: `Connection ${e.id} references a missing node`, edgeId: e.id });
      continue;
    }
    const key = `${e.source}:${e.sourcePort}->${e.target}:${e.targetPort}`;
    if (seenEdges.has(key)) {
      issues.push({ severity: 'warning', code: 'DUPLICATE_EDGE', message: `Duplicate connection ${src.name} → ${tgt.name}`, edgeId: e.id });
      continue;
    }
    seenEdges.add(key);
    if (e.source === e.target) {
      issues.push({ severity: 'error', code: 'SELF_LOOP', message: `${src.name} cannot connect to itself`, edgeId: e.id, nodeId: src.id });
      continue;
    }
    const sdef = registry.get(src.type);
    const tdef = registry.get(tgt.type);
    if (sdef) {
      const outs = getNodeOutputsWithError(sdef.manifest, src.parameters, src.onError);
      if (!outs.some((o) => o.name === e.sourcePort)) {
        issues.push({ severity: 'error', code: 'INVALID_PORT', message: `${src.name} has no output "${e.sourcePort}"`, edgeId: e.id, nodeId: src.id });
      }
    }
    if (tdef) {
      if (tdef.manifest.trigger) {
        issues.push({ severity: 'error', code: 'TRIGGER_INPUT', message: `${tgt.name} is a trigger and cannot have inputs`, edgeId: e.id, nodeId: tgt.id });
      } else if (!tdef.manifest.inputs.some((i) => i.name === e.targetPort)) {
        issues.push({ severity: 'error', code: 'INVALID_PORT', message: `${tgt.name} has no input "${e.targetPort}"`, edgeId: e.id, nodeId: tgt.id });
      }
    }
    outgoing.get(e.source)!.push(e.target);
    indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1);
  }

  // Kahn's algorithm: anything left over sits on a cycle.
  const queue = graph.nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  const deg = new Map(indegree);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const t of outgoing.get(id) ?? []) {
      deg.set(t, (deg.get(t) ?? 0) - 1);
      if (deg.get(t) === 0) queue.push(t);
    }
  }
  if (order.length < graph.nodes.length) {
    const cyclic = graph.nodes.filter((n) => !order.includes(n.id));
    issues.push({
      severity: 'error',
      code: 'CYCLE',
      message: `Workflow contains a cycle (${cyclic.map((n) => n.name).join(', ')}). Use "Loop Over Items" or a sub-workflow instead.`,
      nodeId: cyclic[0]?.id,
    });
  }

  const triggers = graph.nodes.filter((n) => registry.get(n.type)?.manifest.trigger).map((n) => n.id);
  if (options.requireTrigger !== false && triggers.length === 0 && graph.nodes.length > 0) {
    issues.push({ severity: 'error', code: 'NO_TRIGGER', message: 'Add a trigger node (e.g. Manual Trigger) to start the workflow' });
  }

  // Reachability warnings: nodes no trigger can reach will never run.
  const reachable = new Set<string>();
  const stack = [...triggers];
  while (stack.length) {
    const id = stack.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    stack.push(...(outgoing.get(id) ?? []));
  }
  for (const n of graph.nodes) {
    if (!reachable.has(n.id) && triggers.length > 0) {
      issues.push({ severity: 'warning', code: 'UNREACHABLE', message: `${n.name} is not connected to any trigger and will not run`, nodeId: n.id });
    }
  }

  const ok = !issues.some((i) => i.severity === 'error');
  return { ok, issues, ...(ok ? { compiled: { graph, order, triggers } } : {}) };
}
