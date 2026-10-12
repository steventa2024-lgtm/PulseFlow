import { createId, type GraphEdge, type GraphNode, type WorkflowGraph } from "@pulseflow/contracts";

export interface GraphHistory {
  current: () => WorkflowGraph;
  push: (next: WorkflowGraph) => void;
  undo: () => WorkflowGraph;
  redo: () => WorkflowGraph;
  canUndo: () => boolean;
  canRedo: () => boolean;
  reset: (next: WorkflowGraph) => void;
}

export function createHistory(initial: WorkflowGraph, limit = 100): GraphHistory {
  const past: WorkflowGraph[] = [];
  const future: WorkflowGraph[] = [];
  let current = initial;
  return {
    current: () => current,
    push(next) {
      past.push(structuredClone(current));
      if (past.length > limit) past.shift();
      current = next;
      future.length = 0;
    },
    undo() {
      const previous = past.pop();
      if (!previous) return current;
      future.push(current);
      current = previous;
      return current;
    },
    redo() {
      const next = future.pop();
      if (!next) return current;
      past.push(current);
      current = next;
      return current;
    },
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    reset(next) {
      past.length = 0;
      future.length = 0;
      current = next;
    },
  };
}

export function addNode(
  graph: WorkflowGraph,
  manifestId: string,
  position: { x: number; y: number },
  name: string,
): { graph: WorkflowGraph; nodeId: string } {
  const nodeId = createId("n");
  const node: GraphNode = {
    id: nodeId,
    manifestId,
    manifestVersion: "1.0.0",
    position,
    parameters: {},
    name,
  };
  return { nodeId, graph: { ...graph, nodes: [...graph.nodes, node] } };
}

export function moveNode(graph: WorkflowGraph, nodeId: string, position: { x: number; y: number }): WorkflowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => (node.id === nodeId ? { ...node, position } : node)),
  };
}

export function updateNode(
  graph: WorkflowGraph,
  nodeId: string,
  patch: Partial<Pick<GraphNode, "name" | "parameters" | "disabled" | "notes" | "credentialRef">>,
): WorkflowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => (node.id === nodeId ? { ...node, ...patch, parameters: patch.parameters ?? node.parameters } : node)),
  };
}

export function removeNodes(graph: WorkflowGraph, nodeIds: string[]): WorkflowGraph {
  const drop = new Set(nodeIds);
  return {
    ...graph,
    nodes: graph.nodes.filter((node) => !drop.has(node.id)),
    edges: graph.edges.filter((edge) => !drop.has(edge.source) && !drop.has(edge.target)),
  };
}

export function removeEdges(graph: WorkflowGraph, edgeIds: string[]): WorkflowGraph {
  const drop = new Set(edgeIds);
  return { ...graph, edges: graph.edges.filter((edge) => !drop.has(edge.id)) };
}

export function connectNodes(
  graph: WorkflowGraph,
  source: string,
  sourcePort: string,
  target: string,
  targetPort: string,
): WorkflowGraph {
  if (source === target) return graph;
  const id = `e_${source}_${sourcePort}_${target}_${targetPort}`;
  if (graph.edges.some((edge) => edge.id === id)) return graph;
  const edge: GraphEdge = { id, source, sourcePort, target, targetPort };
  return { ...graph, edges: [...graph.edges, edge] };
}
