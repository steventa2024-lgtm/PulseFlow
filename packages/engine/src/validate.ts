import type { NodeRegistry } from "@pulseflow/nodes-core";
import {
  type GraphEdge,
  type GraphNode,
  type ValidationIssue,
  type WorkflowGraph,
  parseGraph,
} from "@pulseflow/contracts";
import { expressionStrings, parseExpression } from "./expr";

export interface ValidationResult {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export function validateGraph(input: unknown, registry: NodeRegistry): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  let graph: WorkflowGraph;
  try {
    graph = parseGraph(input);
  } catch (error) {
    return {
      ok: false,
      errors: [{ level: "error", code: "INVALID_GRAPH", message: error instanceof Error ? error.message : "Invalid graph" }],
      warnings,
    };
  }
  const nodes = new Map<string, GraphNode>();
  for (const node of graph.nodes) {
    if (nodes.has(node.id)) errors.push({ level: "error", code: "DUPLICATE_NODE", message: `Duplicate node ${node.id}`, nodeId: node.id });
    nodes.set(node.id, node);
  }
  const edgeIds = new Set<string>();
  for (const edge of graph.edges) {
    if (edgeIds.has(edge.id)) errors.push({ level: "error", code: "DUPLICATE_EDGE", message: `Duplicate edge ${edge.id}`, edgeId: edge.id });
    edgeIds.add(edge.id);
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) {
      errors.push({ level: "error", code: "DANGLING_EDGE", message: `Edge ${edge.id} references a missing node`, edgeId: edge.id });
    }
  }
  for (const node of graph.nodes) {
    const definition = registry.get(node.manifestId);
    if (!definition) {
      errors.push({ level: "error", code: "UNKNOWN_NODE", message: `Unknown node ${node.manifestId}`, nodeId: node.id });
      continue;
    }
    const inputs = new Set(definition.manifest.inputs.map((port) => port.id));
    const outputs = new Set(definition.manifest.outputs.map((port) => port.id));
    for (const edge of graph.edges.filter((item) => item.source === node.id)) {
      if (!outputs.has(edge.sourcePort)) {
        errors.push({ level: "error", code: "INVALID_PORT", message: `Missing output port ${edge.sourcePort}`, nodeId: node.id, edgeId: edge.id });
      }
    }
    for (const edge of graph.edges.filter((item) => item.target === node.id)) {
      if (!inputs.has(edge.targetPort) && edge.targetPort !== "loop") {
        errors.push({ level: "error", code: "INVALID_PORT", message: `Missing input port ${edge.targetPort}`, nodeId: node.id, edgeId: edge.id });
      }
    }
    for (const field of definition.manifest.fields) {
      if (!field.required) continue;
      const value = node.parameters[field.key];
      if (value === undefined || value === "") {
        errors.push({ level: "error", code: "MISSING_FIELD", message: `${definition.manifest.title} requires ${field.label}`, nodeId: node.id });
      }
    }
    if (definition.manifest.dangerous && node.manifestId === "code.shell" && graph.settings?.allowShell !== true) {
      warnings.push({ level: "warning", code: "SHELL_DISABLED", message: "Shell stays disabled until the workflow grants allowShell", nodeId: node.id });
    }
    for (const source of expressionStrings(node.parameters)) {
      try {
        parseExpression(source);
      } catch (error) {
        errors.push({
          level: "error",
          code: "INVALID_EXPRESSION",
          message: error instanceof Error ? error.message : "Invalid expression",
          nodeId: node.id,
        });
      }
    }
    for (const field of definition.manifest.fields) {
      if (field.type !== "expression") continue;
      const value = node.parameters[field.key];
      if (typeof value !== "string" || value.includes("{{")) continue;
      try {
        parseExpression(value);
      } catch (error) {
        errors.push({
          level: "error",
          code: "INVALID_EXPRESSION",
          message: error instanceof Error ? error.message : "Invalid expression",
          nodeId: node.id,
        });
      }
    }
  }
  detectCycles(graph, errors);
  const triggers = graph.nodes.filter((node) => node.manifestId.startsWith("trigger."));
  if (triggers.length === 0) {
    errors.push({ level: "error", code: "MISSING_TRIGGER", message: "A workflow needs a trigger" });
  }
  const reachable = reachableFromTriggers(graph, triggers.map((node) => node.id));
  for (const node of graph.nodes) {
    if (!reachable.has(node.id)) {
      const issue = { level: node.required ? "error" as const : "warning" as const, code: "UNREACHABLE", message: `Node ${node.id} is unreachable`, nodeId: node.id };
      if (node.required) errors.push(issue);
      else warnings.push(issue);
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

function detectCycles(graph: WorkflowGraph, errors: ValidationIssue[]): void {
  const skip = new Set(graph.edges.filter((edge) => edge.targetPort === "loop").map((edge) => edge.id));
  const adjacent = new Map<string, string[]>();
  for (const node of graph.nodes) adjacent.set(node.id, []);
  for (const edge of graph.edges) {
    if (skip.has(edge.id)) continue;
    adjacent.get(edge.source)?.push(edge.target);
  }
  const color = new Map<string, number>();
  const visit = (id: string) => {
    if (color.get(id) === 1) {
      errors.push({ level: "error", code: "CYCLE", message: `Cycle detected at ${id}`, nodeId: id });
      return;
    }
    if (color.get(id) === 2) return;
    color.set(id, 1);
    for (const next of adjacent.get(id) ?? []) visit(next);
    color.set(id, 2);
  };
  for (const node of graph.nodes) visit(node.id);
}

function reachableFromTriggers(graph: WorkflowGraph, starts: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...starts];
  while (queue.length > 0) {
    const id = queue.shift();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    for (const edge of graph.edges.filter((item) => item.source === id)) queue.push(edge.target);
  }
  return seen;
}

export function incomingEdges(graph: WorkflowGraph, nodeId: string): GraphEdge[] {
  return graph.edges.filter((edge) => edge.target === nodeId && edge.targetPort !== "loop");
}
