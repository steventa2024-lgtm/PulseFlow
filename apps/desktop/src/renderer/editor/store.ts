import { applyEdgeChanges, applyNodeChanges, type Edge as RFEdge, type EdgeChange, type Node as RFNode, type NodeChange } from '@xyflow/react';
import { getNodeOutputsWithError, newId, type NodeCatalogEntry, type NodeInstance, type StepState, type Workflow, type WorkflowGraph, type WorkflowSettings } from '@pulseflow/contracts';
import { create } from 'zustand';

export type FlowNodeData = { instance: NodeInstance };
export type FlowNode = RFNode<FlowNodeData, 'pf'>;

export interface NodeRunState {
  state: StepState;
  attempt: number;
  durationMs: number | null;
  items: number | null;
  error: string | null;
}

export type ConsoleTab = 'timeline' | 'io' | 'logs' | 'errors' | 'history';

interface Snapshot {
  nodes: FlowNode[];
  edges: RFEdge[];
}

interface EditorState {
  workflow: Workflow | null;
  nodes: FlowNode[];
  edges: RFEdge[];
  settings: WorkflowSettings | null;
  name: string;
  description: string;
  revision: number;
  dirty: boolean;
  catalog: Map<string, NodeCatalogEntry>;
  past: Snapshot[];
  future: Snapshot[];
  executionId: string | null;
  runStates: Record<string, NodeRunState>;
  consoleTab: ConsoleTab;
  consoleOpen: boolean;
  ioNodeId: string | null;

  load: (wf: Workflow) => void;
  setCatalog: (entries: NodeCatalogEntry[]) => void;
  markSaved: (wf: Workflow) => void;
  onNodesChange: (changes: NodeChange<FlowNode>[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  connect: (c: { source: string; sourceHandle: string | null; target: string; targetHandle: string | null }) => void;
  addNode: (entry: NodeCatalogEntry, position: { x: number; y: number }, connectFrom?: string | null) => string;
  updateNode: (id: string, patch: Partial<NodeInstance>) => void;
  setParam: (id: string, name: string, value: unknown) => void;
  removeNodes: (ids: string[]) => void;
  duplicateNodes: (ids: string[]) => void;
  setMeta: (patch: { name?: string; description?: string }) => void;
  setSettings: (patch: Partial<WorkflowSettings>) => void;
  undo: () => void;
  redo: () => void;
  selectedIds: () => string[];
  graph: () => WorkflowGraph;
  setExecution: (id: string | null) => void;
  setRunState: (nodeId: string, s: Partial<NodeRunState> & { state: StepState }) => void;
  setRunStates: (states: Record<string, NodeRunState>) => void;
  setConsole: (patch: { tab?: ConsoleTab; open?: boolean; ioNodeId?: string | null }) => void;
}

const HISTORY_LIMIT = 100;

export function toFlowNode(n: NodeInstance, selected = false): FlowNode {
  return { id: n.id, type: 'pf', position: { ...n.position }, data: { instance: n }, selected };
}

export function toFlowEdge(e: { id: string; source: string; sourcePort: string; target: string; targetPort: string }): RFEdge {
  return { id: e.id, source: e.source, sourceHandle: e.sourcePort, target: e.target, targetHandle: e.targetPort, type: 'pf' };
}

export function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`)) return `${base} ${i}`;
}

export const useEditor = create<EditorState>((set, get) => {
  const snapshot = (): Snapshot => ({ nodes: get().nodes, edges: get().edges });
  let dragOrigin: Snapshot | null = null;
  const commit = (next: Partial<Snapshot>) =>
    set((s) => ({ ...next, past: [...s.past, { nodes: s.nodes, edges: s.edges }].slice(-HISTORY_LIMIT), future: [], dirty: true }));
  const patchInstance = (id: string, fn: (n: NodeInstance) => NodeInstance) =>
    commit({ nodes: get().nodes.map((n) => (n.id === id ? { ...n, data: { instance: fn(n.data.instance) } } : n)) });

  return {
    workflow: null,
    nodes: [],
    edges: [],
    settings: null,
    name: '',
    description: '',
    revision: 0,
    dirty: false,
    catalog: new Map(),
    past: [],
    future: [],
    executionId: null,
    runStates: {},
    consoleTab: 'timeline',
    consoleOpen: true,
    ioNodeId: null,

    load: (wf) =>
      set({
        workflow: wf,
        nodes: wf.draft.nodes.map((n) => toFlowNode(n)),
        edges: wf.draft.edges.map(toFlowEdge),
        settings: wf.settings,
        name: wf.name,
        description: wf.description,
        revision: wf.draftRevision,
        dirty: false,
        past: [],
        future: [],
        executionId: null,
        runStates: {},
        ioNodeId: null,
      }),
    setCatalog: (entries) => set({ catalog: new Map(entries.map((e) => [e.type, e])) }),
    markSaved: (wf) => set({ workflow: wf, revision: wf.draftRevision, dirty: false, settings: wf.settings }),

    onNodesChange: (changes) => {
      const dragging = changes.some((c) => c.type === 'position' && c.dragging === true);
      const dragEnd = changes.some((c) => c.type === 'position' && c.dragging === false);
      if (dragging && !dragOrigin) dragOrigin = snapshot();
      const structural = changes.some((c) => c.type === 'remove') || dragEnd;
      const removed = new Set(changes.filter((c) => c.type === 'remove').map((c) => c.id));
      const prev = dragEnd && dragOrigin ? dragOrigin : snapshot();
      if (dragEnd) dragOrigin = null;
      let nodes = applyNodeChanges(changes, get().nodes);
      // Keep the instance position in sync so graph() reflects drags.
      nodes = nodes.map((n) => (n.data.instance.position.x === n.position.x && n.data.instance.position.y === n.position.y ? n : { ...n, data: { instance: { ...n.data.instance, position: { x: Math.round(n.position.x), y: Math.round(n.position.y) } } } }));
      const edges = removed.size ? get().edges.filter((e) => !removed.has(e.source) && !removed.has(e.target)) : get().edges;
      if (structural) set((s) => ({ nodes, edges, past: [...s.past, prev].slice(-HISTORY_LIMIT), future: [], dirty: true }));
      else set({ nodes, edges, ...(changes.some((c) => c.type === 'position') ? { dirty: true } : {}) });
    },
    onEdgesChange: (changes) => {
      const structural = changes.some((c) => c.type === 'remove');
      const edges = applyEdgeChanges(changes, get().edges);
      if (structural) commit({ edges });
      else set({ edges });
    },
    connect: ({ source, sourceHandle, target, targetHandle }) => {
      if (source === target) return;
      const sp = sourceHandle ?? 'main';
      const tp = targetHandle ?? 'main';
      if (get().edges.some((e) => e.source === source && e.target === target && (e.sourceHandle ?? 'main') === sp && (e.targetHandle ?? 'main') === tp)) return;
      commit({ edges: [...get().edges, toFlowEdge({ id: newId('e', 10), source, sourcePort: sp, target, targetPort: tp })] });
    },
    addNode: (entry, position, connectFrom) => {
      const taken = new Set(get().nodes.map((n) => n.data.instance.name));
      const parameters: Record<string, unknown> = {};
      for (const p of entry.parameters) if (p.default !== undefined) parameters[p.name] = structuredClone(p.default);
      const instance: NodeInstance = {
        id: newId('n', 10),
        type: entry.type,
        typeVersion: entry.version,
        name: uniqueName(entry.displayName, taken),
        position: { x: Math.round(position.x), y: Math.round(position.y) },
        parameters,
      };
      const nodes = [...get().nodes.map((n) => (n.selected ? { ...n, selected: false } : n)), toFlowNode(instance, true)];
      let edges = get().edges;
      const from = connectFrom ? get().nodes.find((n) => n.id === connectFrom) : undefined;
      if (from && entry.inputs.length > 0) {
        const fromEntry = get().catalog.get(from.data.instance.type);
        const port = fromEntry ? (getNodeOutputsWithError(fromEntry, from.data.instance.parameters, from.data.instance.onError)[0]?.name ?? 'main') : 'main';
        edges = [...edges, toFlowEdge({ id: newId('e', 10), source: from.id, sourcePort: port, target: instance.id, targetPort: entry.inputs[0]!.name })];
      }
      commit({ nodes, edges });
      return instance.id;
    },
    updateNode: (id, patch) => patchInstance(id, (n) => ({ ...n, ...patch })),
    setParam: (id, name, value) => patchInstance(id, (n) => ({ ...n, parameters: { ...n.parameters, [name]: value } })),
    removeNodes: (ids) => {
      const set_ = new Set(ids);
      commit({ nodes: get().nodes.filter((n) => !set_.has(n.id)), edges: get().edges.filter((e) => !set_.has(e.source) && !set_.has(e.target)) });
    },
    duplicateNodes: (ids) => {
      const taken = new Set(get().nodes.map((n) => n.data.instance.name));
      const idMap = new Map<string, string>();
      const copies: FlowNode[] = [];
      for (const n of get().nodes.filter((x) => ids.includes(x.id))) {
        const id = newId('n', 10);
        idMap.set(n.id, id);
        const name = uniqueName(`${n.data.instance.name} copy`, taken);
        taken.add(name);
        copies.push(toFlowNode({ ...structuredClone(n.data.instance), id, name, position: { x: n.position.x + 40, y: n.position.y + 40 } }, true));
      }
      const internal = get()
        .edges.filter((e) => idMap.has(e.source) && idMap.has(e.target))
        .map((e) => ({ ...e, id: newId('e', 10), source: idMap.get(e.source)!, target: idMap.get(e.target)! }));
      commit({ nodes: [...get().nodes.map((n) => ({ ...n, selected: false })), ...copies], edges: [...get().edges, ...internal] });
    },
    setMeta: (patch) => set({ ...patch, dirty: true }),
    setSettings: (patch) => set((s) => ({ settings: s.settings ? { ...s.settings, ...patch } : s.settings, dirty: true })),
    undo: () => {
      const s = get();
      const prev = s.past.at(-1);
      if (!prev) return;
      set({ nodes: prev.nodes, edges: prev.edges, past: s.past.slice(0, -1), future: [{ nodes: s.nodes, edges: s.edges }, ...s.future], dirty: true });
    },
    redo: () => {
      const s = get();
      const next = s.future[0];
      if (!next) return;
      set({ nodes: next.nodes, edges: next.edges, future: s.future.slice(1), past: [...s.past, { nodes: s.nodes, edges: s.edges }], dirty: true });
    },
    selectedIds: () => get().nodes.filter((n) => n.selected).map((n) => n.id),
    graph: () => ({
      schemaVersion: 1,
      nodes: get().nodes.map((n) => ({ ...n.data.instance, position: { x: Math.round(n.position.x), y: Math.round(n.position.y) } })),
      edges: get().edges.map((e) => ({ id: e.id, source: e.source, sourcePort: e.sourceHandle ?? 'main', target: e.target, targetPort: e.targetHandle ?? 'main' })),
    }),
    setExecution: (id) => set({ executionId: id, runStates: {} }),
    setRunState: (nodeId, s) =>
      set((st) => ({ runStates: { ...st.runStates, [nodeId]: { attempt: 1, durationMs: null, items: null, error: null, ...st.runStates[nodeId], ...s } } })),
    setRunStates: (runStates) => set({ runStates }),
    setConsole: (patch) =>
      set((s) => ({
        consoleTab: patch.tab ?? s.consoleTab,
        consoleOpen: patch.open ?? (patch.tab ? true : s.consoleOpen),
        ioNodeId: patch.ioNodeId !== undefined ? patch.ioNodeId : s.ioNodeId,
      })),
  };
});
