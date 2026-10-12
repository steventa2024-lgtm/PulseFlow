import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
  Handle,
  Position,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import { useEffect, useMemo } from "react";
import type { NodeManifest, WorkflowGraph } from "@pulseflow/contracts";

export interface FlowNodeData extends Record<string, unknown> {
  label: string;
  manifestId: string;
  category: string;
  status: string;
  inputs: Array<{ id: string }>;
  outputs: Array<{ id: string }>;
}

function PulseNode({ data, selected }: NodeProps<Node<FlowNodeData>>) {
  return (
    <div className={`pulse-node status-${data.status} ${selected ? "selected" : ""}`}>
      {data.inputs.map((port, index) => (
        <Handle
          key={port.id}
          type="target"
          position={Position.Left}
          id={port.id}
          style={{ top: `${((index + 1) / (data.inputs.length + 1)) * 100}%` }}
        />
      ))}
      <div className="text-[10px] uppercase tracking-wide text-cyan">{data.category}</div>
      <div className="mt-1 text-sm font-medium">{data.label}</div>
      <div className="mt-1 text-[11px] text-muted">{data.status === "idle" ? data.manifestId : data.status}</div>
      {data.outputs.map((port, index) => (
        <Handle
          key={port.id}
          type="source"
          position={Position.Right}
          id={port.id}
          style={{ top: `${((index + 1) / (data.outputs.length + 1)) * 100}%` }}
        />
      ))}
    </div>
  );
}

const nodeTypes = { pulse: PulseNode };

function uniquePorts(manifestPorts: string[], edgePorts: string[], fallback: string): Array<{ id: string }> {
  const ids = [...new Set([...manifestPorts, ...edgePorts].filter((id) => id.length > 0))];
  return (ids.length > 0 ? ids : [fallback]).map((id) => ({ id }));
}

export function toFlow(
  graph: WorkflowGraph,
  manifests: Map<string, NodeManifest>,
  statuses: Record<string, string>,
): { nodes: Node<FlowNodeData>[]; edges: Edge[] } {
  const nodes: Node<FlowNodeData>[] = graph.nodes.map((node) => {
    const manifest = manifests.get(node.manifestId);
    const inputs = uniquePorts(manifest?.inputs.map((port) => port.id) ?? [], graph.edges.filter((edge) => edge.target === node.id).map((edge) => edge.targetPort), "in");
    const outputs = uniquePorts(manifest?.outputs.map((port) => port.id) ?? [], graph.edges.filter((edge) => edge.source === node.id).map((edge) => edge.sourcePort), "out");
    return {
      id: node.id,
      type: "pulse",
      position: node.position,
      data: {
        label: node.name || manifest?.title || node.id,
        manifestId: node.manifestId,
        category: manifest?.category ?? "node",
        status: statuses[node.id] ?? "idle",
        inputs,
        outputs,
      },
    };
  });
  const edges: Edge[] = graph.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourcePort,
    targetHandle: edge.targetPort,
    label: edge.label ?? edge.sourcePort,
    animated: statuses[edge.source] === "running",
  }));
  return { nodes, edges };
}

export function FlowCanvas({
  graph,
  manifests,
  statuses,
  onConnect,
  onMove,
  onSelect,
}: {
  graph: WorkflowGraph;
  manifests: Map<string, NodeManifest>;
  statuses: Record<string, string>;
  onConnect: (connection: Connection) => void;
  onMove: (nodeId: string, position: { x: number; y: number }) => void;
  onSelect: (nodeId: string | undefined) => void;
}) {
  const flow = useMemo(() => toFlow(graph, manifests, statuses), [graph, manifests, statuses]);
  const [nodes, setNodes, onNodesChange] = useNodesState(flow.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(flow.edges);
  useEffect(() => {
    setNodes(flow.nodes);
    setEdges(flow.edges);
  }, [flow, setEdges, setNodes]);
  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      minZoom={0.2}
      maxZoom={1.8}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onNodeDragStop={(_event, node) => onMove(node.id, node.position)}
      onSelectionChange={({ nodes: selected }) => onSelect(selected[0]?.id)}
      proOptions={{ hideAttribution: false }}
      colorMode="dark"
    >
      <Background color="#243044" gap={16} />
      <MiniMap pannable zoomable maskColor="rgba(11,15,22,0.7)" nodeColor="#3B82F6" />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
