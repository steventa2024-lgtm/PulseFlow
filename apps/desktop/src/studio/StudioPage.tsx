import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { NodeManifest, WorkflowGraph } from "@pulseflow/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import {
  addNode,
  connectNodes,
  createHistory,
  moveNode,
  removeNodes,
  updateNode,
  type GraphHistory,
} from "@pulseflow/editor";
import { Button } from "@pulseflow/ui";
import {
  activateWorkflow,
  deactivateWorkflow,
  exportWorkflow,
  getExecution,
  getWorkflow,
  importBundle,
  listExecutions,
  listFiles,
  listNodes,
  patchSettings,
  readFilePreview,
  runWorkflow,
  saveWorkflow,
  testNode,
  type ExecutionRecord,
  type Issue,
  type StepRecord,
} from "../api";
import { Console } from "./Console";
import { FlowCanvas } from "./FlowCanvas";
import { Inspector } from "./Inspector";
import { Library } from "./Library";

function publicationState(active: boolean, published: boolean): "Active" | "Disabled" | "Draft" {
  if (active) return "Active";
  if (published) return "Disabled";
  return "Draft";
}

function runStateLabel(status: string, state: string | undefined): string | undefined {
  if (status === "Running" || state === "running" || state === "queued") return "Running";
  if (state === "waiting") return "Paused";
  if (state === "succeeded") return "Succeeded";
  if (state === "failed" || state === "timed_out") return "Failed";
  return undefined;
}

export function StudioPage({ tutorialDismissed }: { tutorialDismissed: boolean }) {
  const { workflowId = "wf_a01" } = useParams();
  const queryClient = useQueryClient();
  const detail = useQuery({ queryKey: ["workflow", workflowId], queryFn: () => getWorkflow(workflowId) });
  const nodeQuery = useQuery({ queryKey: ["nodes"], queryFn: listNodes });
  const historyQuery = useQuery({ queryKey: ["executions", workflowId], queryFn: () => listExecutions(workflowId) });
  const [graph, setGraph] = useState<WorkflowGraph | null>(null);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState("Saved");
  const [selected, setSelected] = useState<string>();
  const [issues, setIssues] = useState<Issue[]>([]);
  const [steps, setSteps] = useState<StepRecord[]>([]);
  const [execution, setExecution] = useState<ExecutionRecord>();
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [collapsed, setCollapsed] = useState(false);
  const [palette, setPalette] = useState(false);
  const [query, setQuery] = useState("");
  const [banner, setBanner] = useState(!tutorialDismissed);
  const [preview, setPreview] = useState<string>();
  const [testMessage, setTestMessage] = useState<string>();
  const [active, setActive] = useState(false);
  const [name, setName] = useState("");
  const history = useRef<GraphHistory | null>(null);
  const loaded = useRef("");

  useEffect(() => {
    if (!detail.data || loaded.current === workflowId) return;
    loaded.current = workflowId;
    history.current = createHistory(detail.data.workflow.draftGraph);
    setGraph(detail.data.workflow.draftGraph);
    setIssues([...detail.data.validation.errors, ...detail.data.validation.warnings]);
    setActive(detail.data.workflow.active);
    setName(detail.data.workflow.name);
    setDirty(false);
    setStatus("Saved");
  }, [detail.data, workflowId]);

  useEffect(() => {
    if (!dirty || !graph) return;
    const timer = window.setTimeout(() => {
      void saveWorkflow(workflowId, graph, name)
        .then((saved) => {
          setIssues([...saved.validation.errors, ...saved.validation.warnings]);
          setDirty(false);
          setStatus("Saved");
        })
        .catch((error: unknown) => setStatus(error instanceof Error ? error.message : "Save failed"));
    }, 800);
    return () => window.clearTimeout(timer);
  }, [dirty, graph, name, workflowId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPalette(true);
      } else if (meta && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (graph) void saveWorkflow(workflowId, graph, name);
      } else if (meta && event.key === "Enter") {
        event.preventDefault();
        void run("production");
      } else if (meta && event.key.toLowerCase() === "z") {
        event.preventDefault();
        applyHistory(event.shiftKey ? "redo" : "undo");
      } else if (!typing && (event.key === "Delete" || event.key === "Backspace") && selected && graph) {
        event.preventDefault();
        commit(removeNodes(graph, [selected]));
        setSelected(undefined);
      } else if (event.key === "Escape") {
        setPalette(false);
        setPreview(undefined);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const manifests = useMemo(() => new Map((nodeQuery.data?.nodes ?? []).map((node) => [node.id, node])), [nodeQuery.data]);
  const manifestList = nodeQuery.data?.nodes ?? [];

  function commit(next: WorkflowGraph) {
    history.current?.push(next);
    setGraph(next);
    setDirty(true);
    setStatus("Unsaved");
  }

  function applyHistory(direction: "undo" | "redo") {
    const next = direction === "undo" ? history.current?.undo() : history.current?.redo();
    if (!next) return;
    setGraph(next);
    setDirty(true);
    setStatus("Unsaved");
  }

  async function run(mode: "production" | "demo" | "debug" | "live") {
    if (!graph) return;
    setStatus("Running");
    setStatuses(Object.fromEntries(graph.nodes.map((node) => [node.id, "queued"])));
    try {
      if (dirty) await saveWorkflow(workflowId, graph, name);
      const result = await runWorkflow(workflowId, mode);
      setExecution(result.execution);
      setSteps(result.steps);
      setStatuses(Object.fromEntries(result.steps.map((step) => [step.nodeId, step.state])));
      setStatus(result.result.state);
      setCollapsed(false);
      await queryClient.invalidateQueries({ queryKey: ["executions", workflowId] });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Run failed");
    }
  }

  async function toggleActive() {
    if (active) {
      await deactivateWorkflow(workflowId);
      setActive(false);
    } else {
      const result = await activateWorkflow(workflowId);
      setActive(true);
      if (result.webhooks[0]) setPreview(`Webhook ${result.webhooks[0].id}\nSecret (shown once): ${result.webhooks[0].secret}`);
    }
  }

  async function openFile(fileName: string) {
    const files = await listFiles("demo");
    const match = files.files.find((file) => file === fileName) ?? files.files[0];
    if (!match) {
      setPreview("No demo output file yet. Run the workflow first.");
      return;
    }
    const file = await readFilePreview("demo", match);
    setPreview(file.text);
  }

  const paletteItems = manifestList.filter((manifest) => `${manifest.title} ${manifest.id}`.toLowerCase().includes(query.toLowerCase())).slice(0, 8);

  if (!graph || detail.isLoading) return <p className="p-6 text-muted">Loading workflow…</p>;
  if (detail.isError) return <p className="p-6">This workflow is not in the local database.</p>;

  return (
    <div className="studio-grid">
      <header className="studio-top flex items-center gap-3 overflow-x-auto border-b border-line bg-panel px-3">
        <Link to="/workflow/wf_a01" className="font-semibold">
          PulseFlow
        </Link>
        <span className="text-muted">Workspace</span>
        <input
          aria-label="Workflow name"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setDirty(true);
            setStatus("Unsaved");
          }}
          className="h-8 min-w-40 rounded-xl border border-line bg-canvas px-3 text-sm"
        />
        <span className="text-xs text-muted">{status}</span>
        <span className="rounded-lg border border-line px-2 py-1 text-xs" aria-label="Workflow state">
          {publicationState(active, Boolean(detail.data?.workflow.currentPublishedVersionId))}
        </span>
        {runStateLabel(status, execution?.state) && (
          <span className="rounded-lg border border-line px-2 py-1 text-xs" aria-label="Run state">
            {runStateLabel(status, execution?.state)}
            {execution?.mode === "demo" ? " · demo" : execution?.mode === "live" ? " · live" : ""}
          </span>
        )}
        <nav className="ml-auto flex items-center gap-2">
          <Link className="text-sm text-muted" to="/templates">
            Templates
          </Link>
          <Link className="text-sm text-muted" to="/history">
            History
          </Link>
          <Button type="button" onClick={() => void run("demo")}>
            Run demo
          </Button>
          <Button type="button" onClick={() => void run("production")}>
            Run
          </Button>
          <Button type="button" tone="primary" onClick={() => void toggleActive()}>
            {active ? "Deactivate" : "Activate"}
          </Button>
          <Link aria-label="Settings" className="px-2 text-lg" to="/settings">
            ⚙
          </Link>
        </nav>
      </header>
      <Library
        manifests={manifestList}
        onAdd={(manifest) => {
          const added = addNode(graph, manifest.id, { x: 80 + graph.nodes.length * 28, y: 160 }, manifest.title);
          commit(added.graph);
          setSelected(added.nodeId);
        }}
      />
      <div
        className="relative min-h-0"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          const manifestId = event.dataTransfer.getData("application/pulseflow-node");
          const manifest = manifests.get(manifestId);
          if (!manifest) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          const added = addNode(graph, manifest.id, { x: event.clientX - bounds.left, y: event.clientY - bounds.top }, manifest.title);
          commit(added.graph);
          setSelected(added.nodeId);
        }}
      >
        <FlowCanvas
          graph={graph}
          manifests={manifests}
          statuses={statuses}
          onConnect={(connection) => {
            if (!connection.source || !connection.target) return;
            commit(connectNodes(graph, connection.source, connection.sourceHandle ?? "out", connection.target, connection.targetHandle ?? "in"));
          }}
          onMove={(nodeId, position) => commit(moveNode(graph, nodeId, position))}
          onSelect={setSelected}
        />
        {banner && workflowId === "wf_a01" && (
          <div className="absolute left-4 top-4 max-w-md rounded-2xl border border-line bg-panel-2 p-4 shadow-lg">
            <h2 className="font-semibold">Hello Automation is ready</h2>
            <p className="mt-1 text-sm text-muted">Run demo executes the installed template, writes JSON in the app demo folder, and stores the trace.</p>
            <div className="mt-3 flex gap-2">
              <Button
                type="button"
                tone="primary"
                onClick={() => {
                  setBanner(false);
                  void patchSettings({ tutorialDismissed: true });
                  void run("demo");
                }}
              >
                Run demo
              </Button>
              <Button
                type="button"
                tone="quiet"
                onClick={() => {
                  setBanner(false);
                  void patchSettings({ tutorialDismissed: true });
                }}
              >
                Dismiss
              </Button>
            </div>
          </div>
        )}
      </div>
      <Inspector
        graph={graph}
        nodeId={selected}
        manifest={selected ? manifests.get(graph.nodes.find((node) => node.id === selected)?.manifestId ?? "") : undefined}
        issues={issues}
        testMessage={testMessage}
        onChange={(parameters, nodeName) => {
          if (!selected) return;
          commit(updateNode(graph, selected, { parameters, name: nodeName }));
        }}
        onTest={() => {
          if (!selected) return;
          void testNode(workflowId, selected)
            .then((result) => {
              setSteps(result.steps);
              setStatuses(Object.fromEntries(result.steps.map((step) => [step.nodeId, step.state])));
              setTestMessage(result.result.state);
            })
            .catch((error: unknown) => setTestMessage(error instanceof Error ? error.message : "Test failed"));
        }}
      />
      <Console
        execution={execution}
        steps={steps}
        history={historyQuery.data?.executions ?? []}
        collapsed={collapsed}
        onToggle={() => setCollapsed((value) => !value)}
        onOpenExecution={(id) => {
          void getExecution(id).then((result) => {
            setExecution(result.execution);
            setSteps(result.steps);
            setStatuses(Object.fromEntries(result.steps.map((step) => [step.nodeId, step.state])));
          });
        }}
        onOpenFile={(fileName) => void openFile(fileName)}
      />
      {palette && (
        <div className="fixed inset-0 z-20 flex items-start justify-center bg-black/50 p-16" onClick={() => setPalette(false)}>
          <div className="w-full max-w-lg rounded-2xl border border-line bg-panel p-3" onClick={(event) => event.stopPropagation()}>
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search nodes and commands"
              className="h-10 w-full rounded-xl border border-line bg-canvas px-3"
            />
            <ul className="mt-2">
              <li>
                <button type="button" className="w-full rounded-lg px-2 py-2 text-left text-sm hover:bg-panel-2" onClick={() => void run("production")}>
                  Test workflow
                </button>
              </li>
              {paletteItems.map((manifest: NodeManifest) => (
                <li key={manifest.id}>
                  <button
                    type="button"
                    className="w-full rounded-lg px-2 py-2 text-left text-sm hover:bg-panel-2"
                    onClick={() => {
                      const added = addNode(graph, manifest.id, { x: 160, y: 160 }, manifest.title);
                      commit(added.graph);
                      setPalette(false);
                    }}
                  >
                    Add {manifest.title}
                  </button>
                </li>
              ))}
              <li>
                <button
                  type="button"
                  className="w-full rounded-lg px-2 py-2 text-left text-sm hover:bg-panel-2"
                  onClick={() => {
                    void exportWorkflow(workflowId).then((bundle) => {
                      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
                      const url = URL.createObjectURL(blob);
                      const anchor = document.createElement("a");
                      anchor.href = url;
                      anchor.download = `${workflowId}.pulseflow.json`;
                      anchor.click();
                      URL.revokeObjectURL(url);
                    });
                  }}
                >
                  Export workflow
                </button>
              </li>
              <li>
                <label className="block cursor-pointer rounded-lg px-2 py-2 text-sm hover:bg-panel-2">
                  Import bundle
                  <input
                    type="file"
                    accept="application/json"
                    className="hidden"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (!file) return;
                      void file.text().then((text) => importBundle(JSON.parse(text) as unknown)).then(() => queryClient.invalidateQueries({ queryKey: ["workflows"] }));
                    }}
                  />
                </label>
              </li>
            </ul>
            <p className="mt-2 text-xs text-muted">Ctrl+K search · Ctrl+Z undo · Ctrl+Enter test · Delete removes the selected node</p>
          </div>
        </div>
      )}
      {preview && (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/50 p-8" onClick={() => setPreview(undefined)}>
          <pre className="max-h-[70vh] max-w-3xl overflow-auto rounded-2xl border border-line bg-panel p-4 text-xs" onClick={(event) => event.stopPropagation()}>
            {preview}
          </pre>
        </div>
      )}
    </div>
  );
}
