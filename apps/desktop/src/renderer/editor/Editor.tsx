import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type IsValidConnection,
} from '@xyflow/react';
import type { NodeCatalogEntry, ValidationIssue, Workflow, WorkflowGraph } from '@pulseflow/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  CheckCircle2,
  CircleAlert,
  Copy,
  Download,
  History,
  Loader2,
  MoreHorizontal,
  PanelRight,
  Play,
  Plus,
  Redo2,
  Rocket,
  Save,
  Trash2,
  Undo2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { ApiError, api } from '../lib/api';
import { useEngineEvents } from '../lib/events';
import { relativeTime } from '../lib/format';
import { navigate } from '../lib/router';
import { Badge, Button, IconButton, Spinner, Switch, Tabs, cx, toast } from '../components/ui';
import { deriveRunStates, ExecutionConsole, useExecution } from './Console';
import { NodeTestDialog, PermissionsDialog, PublishDialog, requiredPermissions, VersionsDialog } from './Dialogs';
import { compareVersions } from './comparison';
import { FlowEdge, FlowNode } from './FlowNode';
import { Inspector } from './Inspector';
import { DRAG_MIME, Library } from './Library';
import { useEditor } from './store';

const nodeTypes = { pf: FlowNode };
const edgeTypes = { pf: FlowEdge };

export function EditorPage({ id }: { id: string }) {
  return (
    <ReactFlowProvider>
      <Editor id={id} />
    </ReactFlowProvider>
  );
}

function downloadJson(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function isTyping(): boolean {
  const el = document.activeElement as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

function Editor({ id }: { id: string }) {
  const qc = useQueryClient();
  const rf = useReactFlow();
  const wfQuery = useQuery({ queryKey: ['workflow', id], queryFn: () => api.workflow(id), staleTime: Infinity, refetchOnWindowFocus: false });
  const catalogQuery = useQuery({ queryKey: ['nodes'], queryFn: api.nodes });
  const { nodes, edges, dirty, workflow, name, settings, description, executionId, past, future, consoleOpen, consoleTab } = useEditor();
  // Store actions never change identity; the state object returned by getState() does.
  const [ed] = useState(() => useEditor.getState());
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [testing, setTesting] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [testNodeId, setTestNodeId] = useState<string | null>(null);
  const [validating, setValidating] = useState(true);
  const [validationFailed, setValidationFailed] = useState(false);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [dialog, setDialog] = useState<null | 'permissions' | 'versions' | 'publish' | 'deploy' | 'activate-permissions' | 'deploy-permissions'>(null);
  const [menu, setMenu] = useState(false);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const loadedFor = useRef<string | null>(null);
  const saveInFlight = useRef<Promise<Workflow | null> | null>(null);
  const actionInFlight = useRef(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (useEditor.getState().nodes.length) void rf.fitView({ padding: 0.18, maxZoom: 1.1 });
      }, 100);
    });
    if (canvasRef.current) observer.observe(canvasRef.current);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [rf, workflow?.id]);
  const selectedNodeId = nodes.find((n) => n.selected)?.id;
  useEffect(() => {
    if (selectedNodeId) setInspectorOpen(true);
  }, [selectedNodeId]);
  const versions = useQuery({ queryKey: ['versions', id], queryFn: () => api.versions(id), enabled: !!workflow?.publishedVersionId });
  const published = versions.data?.find((v) => v.id === workflow?.publishedVersionId);
  const changedSincePublish = dirty || !!(published && settings && compareVersions(published, { graph: useEditor.getState().graph(), settings }).length);
  const validationGraph = JSON.stringify(ed.graph());

  useEffect(() => {
    if (catalogQuery.data) ed.setCatalog(catalogQuery.data);
  }, [catalogQuery.data, ed]);

  useEffect(() => {
    if (wfQuery.data && loadedFor.current !== wfQuery.data.id) {
      loadedFor.current = wfQuery.data.id;
      ed.load(wfQuery.data);
      requestAnimationFrame(() => void rf.fitView({ padding: 0.25, maxZoom: 1.1 }));
      void api
        .executions({ workflowId: wfQuery.data.id, limit: 1 })
        .then((l) => l[0] && useEditor.getState().workflow?.id === id && !useEditor.getState().executionId && ed.setExecution(l[0].id))
        .catch(() => undefined);
    }
  }, [wfQuery.data, wfQuery.dataUpdatedAt, ed, rf, id]);

  const exec = useExecution(executionId);
  useEffect(() => {
    if (exec.data && exec.data.id === useEditor.getState().executionId) ed.setRunStates(deriveRunStates(exec.data.steps));
  }, [exec.data, ed]);

  useEngineEvents(
    (e) => {
      const cur = useEditor.getState().executionId;
      if ((e.type === 'step.updated' || e.type === 'execution.updated') && e.executionId === cur) {
        if (e.type === 'step.updated')
          ed.setRunState(e.nodeId, { state: e.state, attempt: e.attempt, durationMs: e.durationMs ?? null, error: e.error?.message ?? null });
        void qc.invalidateQueries({ queryKey: ['execution', cur] });
      }
      if (e.type === 'execution.updated' && e.workflowId === id) void qc.invalidateQueries({ queryKey: ['executions', { workflowId: id }] });
    },
    [id],
  );

  const save = useCallback(async (): Promise<Workflow | null> => {
    while (saveInFlight.current) {
      if (!(await saveInFlight.current)) return null;
    }
    const s = useEditor.getState();
    if (!s.workflow) return null;
    const workflowId = s.workflow.id;
    if (!s.dirty) return s.workflow;
    setSaving(true);
    const persist = async (): Promise<Workflow | null> => {
      const snapshot = { nodes: s.nodes, edges: s.edges, settings: s.settings, name: s.name, description: s.description };
      try {
        const { permissions: _p, errorWorkflowId, ...settings } = s.settings!;
        const wf = await api.updateWorkflow(workflowId, {
          name: s.name.trim() || 'Untitled workflow',
          description: s.description,
          draft: s.graph(),
          settings: { ...settings, ...(errorWorkflowId ? { errorWorkflowId } : {}) },
          baseRevision: s.revision,
        });
        const now = useEditor.getState();
        const unchanged =
          now.nodes === snapshot.nodes &&
          now.edges === snapshot.edges &&
          now.settings === snapshot.settings &&
          now.name === snapshot.name &&
          now.description === snapshot.description;
        if (now.workflow?.id === workflowId) useEditor.setState({ workflow: wf, revision: wf.draftRevision, dirty: !unchanged });
        qc.setQueryData(['workflow', wf.id], wf);
        void qc.invalidateQueries({ queryKey: ['workflows'] });
        return wf;
      } catch (e) {
        if (e instanceof ApiError && e.code === 'REVISION_CONFLICT')
          toast.error('This workflow was changed elsewhere', 'Reload to get the latest draft. Your unsaved edits are still on screen.');
        else toast.error('Save failed', e);
        return null;
      } finally {
        setSaving(false);
      }
    };
    const pending = persist();
    saveInFlight.current = pending;
    try {
      return await pending;
    } finally {
      saveInFlight.current = null;
    }
  }, [qc]);

  // Autosave shortly after edits settle.
  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(() => void save(), 1200);
    return () => clearTimeout(t);
  }, [dirty, nodes, edges, name, settings, description, save]);

  // Live validation of the draft.
  useEffect(() => {
    if (workflow?.id !== id) return;
    let disposed = false;
    setValidating(true);
    setValidationFailed(false);
    const t = setTimeout(() => {
      void api
        .validate(id, JSON.parse(validationGraph) as WorkflowGraph)
        .then((r) => {
          if (!disposed) setIssues(r.issues);
        })
        .catch(() => {
          if (!disposed) setValidationFailed(true);
        })
        .finally(() => {
          if (!disposed) setValidating(false);
        });
    }, 500);
    return () => {
      disposed = true;
      clearTimeout(t);
    };
  }, [id, workflow?.id, validationGraph]);

  const run = useCallback(async () => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setRunning(true);
    try {
      const wf = await save();
      if (!wf) return;
      if (useEditor.getState().dirty) return toast.error('Draft changed during save', 'Save the latest edits before running.');
      const r = await api.run(wf.id, { useDraft: true });
      if (useEditor.getState().workflow?.id === wf.id) {
        ed.setExecution(r.executionId);
        ed.setConsole({ tab: 'timeline', open: true });
      }
      void qc.invalidateQueries({ queryKey: ['executions'] });
    } catch (e) {
      toast.error('Run failed to start', e);
    } finally {
      setRunning(false);
      actionInFlight.current = false;
    }
  }, [save, ed, qc]);

  const publish = async (note: string, deploy = false) => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setDeploying(true);
    setDialog(null);
    try {
      const wf = await save();
      if (!wf) return;
      if (useEditor.getState().dirty) return toast.error('Draft changed during save', 'Save the latest edits before deploying.');
      const v = await api.publish(wf.id, note);
      const fresh = deploy ? await api.activate(wf.id) : await api.workflow(wf.id);
      if (useEditor.getState().workflow?.id === wf.id) useEditor.setState({ workflow: fresh, settings: fresh.settings });
      toast.ok(
        deploy ? `Deployed locally · v${v.versionNumber}` : `Published v${v.versionNumber}`,
        deploy ? 'Triggers are active on this computer.' : wf.active ? 'Active triggers now use this version.' : undefined,
      );
      void qc.invalidateQueries({ queryKey: ['workflows'] });
      void qc.invalidateQueries({ queryKey: ['versions', wf.id] });
      void qc.invalidateQueries({ queryKey: ['triggers', wf.id] });
    } catch (e) {
      toast.error(
        deploy ? 'Local deployment incomplete' : 'Publish blocked',
        e instanceof ApiError && e.code === 'WORKFLOW_INVALID' ? 'Fix the validation errors first.' : e,
      );
      const fresh = await api.workflow(id).catch(() => null);
      if (fresh && useEditor.getState().workflow?.id === id) useEditor.setState({ workflow: fresh });
    } finally {
      setDeploying(false);
      actionInFlight.current = false;
      void qc.invalidateQueries({ queryKey: ['versions', id] });
    }
  };

  const testNode = async (items: { json: Record<string, unknown> }[], inputPort?: string) => {
    if (!testNodeId || actionInFlight.current) return;
    const nodeId = testNodeId;
    setTestNodeId(null);
    actionInFlight.current = true;
    setTesting(true);
    try {
      const wf = await save();
      if (!wf) return;
      if (useEditor.getState().dirty) return toast.error('Draft changed during save', 'Save before testing the node.');
      const result = await api.testNode(wf.id, nodeId, { items, ...(inputPort ? { inputPort } : {}), baseRevision: wf.draftRevision });
      if (useEditor.getState().workflow?.id === wf.id) {
        ed.setExecution(result.executionId);
        ed.setConsole({ tab: 'io', open: true, ioNodeId: nodeId });
      }
      void qc.invalidateQueries({ queryKey: ['executions'] });
    } catch (e) {
      toast.error('Node test could not start', e);
    } finally {
      setTesting(false);
      actionInFlight.current = false;
    }
  };

  const requestDeploy = () => {
    const needs = requiredPermissions();
    const sensitive = ['fs.read', 'fs.write', 'email', 'advanced'].some((p) => needs.has(p));
    setDialog(sensitive && !useEditor.getState().settings?.permissions.confirmedAt ? 'deploy-permissions' : 'deploy');
  };

  const doActivate = async () => {
    const wf = await save();
    if (!wf) return;
    try {
      const fresh = await api.activate(wf.id);
      useEditor.setState({ workflow: fresh, settings: fresh.settings });
      toast.ok('Workflow is active', 'Its triggers now run the published version, even when this window is closed to the tray.');
      void qc.invalidateQueries({ queryKey: ['workflows'] });
      void qc.invalidateQueries({ queryKey: ['triggers', wf.id] });
    } catch (e) {
      toast.error('Could not activate', e);
    }
  };

  const toggleActive = async (on: boolean) => {
    if (!workflow) return;
    if (!on) {
      const fresh = await api.deactivate(workflow.id);
      useEditor.setState({ workflow: fresh });
      void qc.invalidateQueries({ queryKey: ['workflows'] });
      return toast.info('Workflow deactivated');
    }
    const needs = requiredPermissions();
    const sensitive = ['fs.read', 'fs.write', 'email', 'advanced'].some((p) => needs.has(p));
    if (sensitive && !useEditor.getState().settings?.permissions.confirmedAt) return setDialog('activate-permissions');
    await doActivate();
  };

  const addAt = useCallback(
    (entry: NodeCatalogEntry, position?: { x: number; y: number }) => {
      const sel = useEditor.getState().nodes.filter((n) => n.selected);
      const from = sel.length === 1 ? sel[0]! : null;
      let pos = position;
      if (!pos) {
        if (from) pos = { x: from.position.x + 300, y: from.position.y };
        else {
          const bounds = document.querySelector('.react-flow')?.getBoundingClientRect();
          pos = rf.screenToFlowPosition({
            x: (bounds?.left ?? 0) + (bounds?.width ?? 800) / 2 - 114,
            y: (bounds?.top ?? 0) + (bounds?.height ?? 600) / 2 - 30,
          });
        }
      }
      ed.addNode(entry, pos, position ? null : from?.id);
      setLibraryOpen(false);
      setInspectorOpen(true);
    },
    [ed, rf],
  );

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const type = e.dataTransfer.getData(DRAG_MIME);
    const entry = type ? useEditor.getState().catalog.get(type) : undefined;
    if (entry) addAt(entry, rf.screenToFlowPosition({ x: e.clientX - 114, y: e.clientY - 26 }));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save().then((wf) => wf && toast.ok('Saved'));
      } else if (mod && e.key === 'Enter') {
        e.preventDefault();
        void run();
      } else if (e.key === 'Escape') {
        setLibraryOpen(false);
        setIssuesOpen(false);
        if (libraryOpen) requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('[data-testid="add-node"]')?.focus());
      } else if (isTyping()) {
        return;
      } else if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        ed.undo();
      } else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
        e.preventDefault();
        ed.redo();
      } else if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        ed.duplicateNodes(ed.selectedIds());
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save, run, ed, libraryOpen]);

  const isValidConnection: IsValidConnection = useCallback((c) => c.source !== c.target, []);
  const errors = issues.filter((i) => i.severity === 'error');
  const catalog = useMemo(() => catalogQuery.data ?? [], [catalogQuery.data]);
  const triggers = useMemo(() => catalog.filter((c) => ['core.manualTrigger', 'core.scheduleTrigger', 'core.webhookTrigger'].includes(c.type)), [catalog]);
  const automatic = nodes.some(
    (n) => !n.data.instance.disabled && catalog.find((c) => c.type === n.data.instance.type)?.trigger && n.data.instance.type !== 'core.manualTrigger',
  );
  const busy = running || testing || deploying;

  if (wfQuery.isError) return <div className="p-8 text-sm text-bad">Could not load workflow: {(wfQuery.error as Error).message}</div>;
  if (!workflow || workflow.id !== id)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size={20} />
      </div>
    );

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col" data-testid="editor">
      <header className="studio-header">
        <div className="studio-topbar">
          <IconButton label="Back to workflows" onClick={() => navigate('/')}>
            <ArrowLeft size={16} />
          </IconButton>
          <div className="min-w-0 flex-1">
            <div className="mb-0.5 px-1.5 text-[10px] text-faint">
              Workspace <span className="mx-1.5">/</span> Workflows
            </div>
            <input
              aria-label="Workflow name"
              data-testid="workflow-name"
              value={name}
              onChange={(e) => ed.setMeta({ name: e.target.value })}
              className="w-full max-w-[420px] truncate rounded-md border border-transparent bg-transparent px-1.5 py-1 text-[15px] font-semibold hover:border-line focus:border-accent focus:outline-none"
            />
          </div>
          <Button
            icon={<Save size={14} />}
            onClick={() => void save().then((wf) => wf && toast.ok('Draft saved'))}
            disabled={saving || busy}
            data-testid="save"
            title="Save draft (Ctrl+S)"
          >
            Save
          </Button>
          <Button
            variant="primary"
            icon={running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
            onClick={() => void run()}
            disabled={busy || validating || validationFailed || errors.length > 0}
            data-testid="run"
            title="Execute the saved draft (Ctrl+Enter)"
          >
            Run
          </Button>
          <Button
            className="deploy-button"
            icon={deploying ? <Loader2 size={14} className="animate-spin" /> : <Rocket size={14} />}
            onClick={requestDeploy}
            disabled={busy || validating || validationFailed || errors.length > 0 || !automatic}
            data-testid="deploy"
            title={automatic ? 'Validate, publish and activate on this computer' : 'Add an automatic trigger to deploy. Manual workflows can run on demand.'}
          >
            Deploy
          </Button>
          <div className="relative">
            <IconButton label="More actions" onClick={() => setMenu((v) => !v)}>
              <MoreHorizontal size={17} />
            </IconButton>
            {menu ? (
              <div className="absolute top-9 right-0 z-30 w-56 rounded-xl border border-line bg-raised p-1 shadow-2xl" onMouseLeave={() => setMenu(false)}>
                <MenuItem
                  icon={<History size={14} />}
                  onClick={() => {
                    setMenu(false);
                    setDialog('versions');
                  }}
                >
                  Version history
                </MenuItem>
                <MenuItem
                  icon={<Rocket size={14} />}
                  onClick={() => {
                    setMenu(false);
                    setDialog('publish');
                  }}
                >
                  Publish version
                </MenuItem>
                <MenuItem
                  icon={<Copy size={14} />}
                  onClick={() => {
                    setMenu(false);
                    void api
                      .duplicateWorkflow(workflow.id)
                      .then((w) => {
                        void qc.invalidateQueries({ queryKey: ['workflows'] });
                        navigate(`/workflows/${w.id}`);
                      })
                      .catch((e) => toast.error('Duplicate failed', e));
                  }}
                >
                  Duplicate
                </MenuItem>
                <MenuItem
                  icon={<Download size={14} />}
                  onClick={() => {
                    setMenu(false);
                    void save()
                      .then((w) => (w ? api.exportBundle([w.id]) : null))
                      .then((bundle) => {
                        if (bundle) downloadJson(`${name.replace(/[^\w-]+/g, '_')}.pulseflow.json`, bundle);
                      })
                      .catch((e) => toast.error('Export failed', e));
                  }}
                >
                  Export (no secrets)
                </MenuItem>
                <MenuItem
                  icon={<Trash2 size={14} />}
                  danger
                  onClick={() => {
                    setMenu(false);
                    if (!window.confirm(`Delete “${workflow.name}”? Its run history is deleted too.`)) return;
                    void api
                      .deleteWorkflow(workflow.id)
                      .then(() => {
                        void qc.invalidateQueries({ queryKey: ['workflows'] });
                        navigate('/');
                      })
                      .catch((e) => toast.error('Delete failed', e));
                  }}
                >
                  Delete
                </MenuItem>
              </div>
            ) : null}
          </div>
        </div>
        <div className="studio-statusbar">
          <Badge tone={workflow.active ? 'ok' : workflow.publishedVersionId ? 'violet' : 'neutral'}>
            {workflow.active ? 'Active locally' : workflow.publishedVersionId ? 'Published · inactive' : 'Draft'}
          </Badge>
          {workflow.publishedVersionId && changedSincePublish ? <Badge tone="warn">Draft changes</Badge> : null}
          {workflow.tags.includes('demo') ? <Badge tone="cyan">Demo · local fixtures</Badge> : null}
          <span className="flex items-center gap-1.5 text-[11px] text-faint" data-testid="save-state" aria-live="polite">
            {saving ? (
              <>
                <Loader2 size={12} className="animate-spin" /> Saving…
              </>
            ) : dirty ? (
              'Unsaved changes'
            ) : (
              <>
                <CheckCircle2 size={12} /> Saved
              </>
            )}
          </span>
          <div className="flex-1" />
          <div className="relative">
            <button
              type="button"
              data-testid="validation"
              aria-expanded={issuesOpen}
              onClick={() => setIssuesOpen((v) => !v)}
              className={cx(
                'flex h-7 items-center gap-1.5 rounded-md px-2 text-xs hover:bg-hover',
                validationFailed || errors.length ? 'text-bad' : issues.length ? 'text-warn' : 'text-muted',
              )}
            >
              {validating ? (
                <Loader2 size={13} className="animate-spin" />
              ) : issues.length || validationFailed ? (
                <CircleAlert size={13} />
              ) : (
                <CheckCircle2 size={13} className="text-ok" />
              )}
              {validating
                ? 'Validating…'
                : validationFailed
                  ? 'Validation unavailable'
                  : errors.length
                    ? `${errors.length} error${errors.length > 1 ? 's' : ''}`
                    : issues.length
                      ? `${issues.length} warning${issues.length > 1 ? 's' : ''}`
                      : 'Valid'}
            </button>
            {issuesOpen && issues.length ? (
              <div className="absolute top-8 right-0 z-30 max-h-72 w-80 overflow-y-auto rounded-xl border border-line bg-raised p-1.5 shadow-2xl">
                {issues.map((issue, k) => (
                  <button
                    key={k}
                    type="button"
                    className="flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left text-xs hover:bg-hover"
                    onClick={() => {
                      if (issue.nodeId) {
                        useEditor.setState((s) => ({ nodes: s.nodes.map((n) => ({ ...n, selected: n.id === issue.nodeId })) }));
                        const n = rf.getNode(issue.nodeId);
                        if (n) void rf.setCenter(n.position.x + 114, n.position.y + 30, { zoom: 1, duration: 300 });
                        setInspectorOpen(true);
                      }
                      setIssuesOpen(false);
                    }}
                  >
                    <CircleAlert size={13} className={cx('mt-px shrink-0', issue.severity === 'error' ? 'text-bad' : 'text-warn')} />
                    <span>{issue.message}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <IconButton label="Version history" onClick={() => setDialog('versions')}>
            <History size={15} />
          </IconButton>
          {automatic ? (
            <label className="flex items-center gap-2 border-l border-line pl-3 text-xs text-muted">
              Active
              <Switch checked={workflow.active} onChange={(v) => void toggleActive(v).catch((e) => toast.error('Activation failed', e))} label="Active" />
            </label>
          ) : (
            <span className="text-[11px] text-faint">Manual · on demand</span>
          )}
        </div>
        {workflow.tags.includes('demo') ? (
          <div className="border-t border-cyan/15 bg-cyan/5 px-4 py-2 text-xs text-cyan" data-testid="demo-banner">
            Demo workflow · uses bundled local fixtures. No live publication is confirmed by a demo run.
          </div>
        ) : null}
      </header>
      <div className="studio-toolbar">
        <Tabs
          value={!consoleOpen ? 'editor' : consoleTab === 'logs' ? 'logs' : 'executions'}
          onChange={(value) => ed.setConsole(value === 'editor' ? { open: false } : { open: true, tab: value === 'logs' ? 'logs' : 'history' })}
          tabs={[
            { id: 'editor', label: 'Editor' },
            { id: 'executions', label: 'Executions' },
            { id: 'logs', label: 'Logs' },
          ]}
        />
        <div className="flex-1" />
        <IconButton label="Undo (Ctrl+Z)" disabled={!past.length} onClick={ed.undo}>
          <Undo2 size={15} />
        </IconButton>
        <IconButton label="Redo (Ctrl+Y)" disabled={!future.length} onClick={ed.redo}>
          <Redo2 size={15} />
        </IconButton>
        <Button size="sm" icon={<Plus size={14} />} onClick={() => setLibraryOpen((v) => !v)} aria-expanded={libraryOpen} data-testid="add-node">
          Add node
        </Button>
        <IconButton label="Open configuration" onClick={() => setInspectorOpen(true)} className="configuration-toggle">
          <PanelRight size={15} />
        </IconButton>
      </div>
      <div className="relative flex min-h-0 flex-1">
        {libraryOpen ? <Library catalog={catalog} onAdd={(e) => addAt(e)} onClose={() => setLibraryOpen(false)} /> : null}
        <div className="flex min-w-0 flex-1 flex-col">
          <div
            className="relative min-h-0 flex-1"
            onDragOver={(e) => (e.preventDefault(), (e.dataTransfer.dropEffect = 'move'))}
            onDrop={onDrop}
            data-testid="canvas"
            ref={canvasRef}
          >
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodesChange={ed.onNodesChange}
              onEdgesChange={ed.onEdgesChange}
              onConnect={(c: Connection) => ed.connect(c)}
              isValidConnection={isValidConnection}
              deleteKeyCode={['Delete', 'Backspace']}
              multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
              snapToGrid
              snapGrid={[8, 8]}
              minZoom={0.2}
              maxZoom={2}
              colorMode="dark"
              proOptions={{ hideAttribution: true }}
              onPaneClick={() => setIssuesOpen(false)}
              onNodeClick={() => setInspectorOpen(true)}
              defaultEdgeOptions={{ type: 'pf' }}
            >
              <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} color="#2d2f40" />
              <Controls showInteractive={false} position="bottom-left" />
              <MiniMap pannable zoomable position="bottom-right" nodeColor="#223047" maskColor="rgb(11 15 22 / 0.7)" style={{ width: 160, height: 100 }} />
            </ReactFlow>
            {nodes.length === 0 ? (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div
                  className="pointer-events-auto rounded-2xl border border-line bg-panel/90 p-6 text-center shadow-2xl backdrop-blur"
                  data-testid="empty-canvas"
                >
                  <div className="text-[15px] font-semibold">Start with a trigger</div>
                  <div className="mt-1 mb-4 text-xs text-muted">Pick how this workflow starts. You can drag any node from the Library too.</div>
                  <div className="flex gap-2">
                    {triggers.map((t) => (
                      <Button key={t.type} onClick={() => addAt(t)}>
                        {t.displayName}
                      </Button>
                    ))}
                  </div>
                </div>
              </div>
            ) : null}
          </div>
          <ExecutionConsole
            workflowId={workflow.id}
            onRetried={(eid) => {
              ed.setExecution(eid);
              ed.setConsole({ tab: 'timeline', open: true });
            }}
          />
        </div>
        <Inspector
          issues={issues}
          onReviewPermissions={() => {
            setInspectorOpen(false);
            setDialog('permissions');
          }}
          open={inspectorOpen}
          onClose={() => setInspectorOpen(false)}
          onTestNode={(nodeId) => {
            setInspectorOpen(false);
            setTestNodeId(nodeId);
          }}
          testing={busy}
        />
      </div>

      <PermissionsDialog
        open={dialog === 'permissions' || dialog === 'activate-permissions' || dialog === 'deploy-permissions'}
        intent={dialog === 'activate-permissions' ? 'Save & activate' : dialog === 'deploy-permissions' ? 'Save & review deployment' : undefined}
        onClose={() => setDialog(null)}
        onSaved={(wf) => {
          useEditor.setState((s) => ({ workflow: wf, settings: s.settings ? { ...s.settings, permissions: wf.settings.permissions } : wf.settings }));
          if (dialog === 'activate-permissions') void doActivate();
          if (dialog === 'deploy-permissions') setDialog('deploy');
        }}
      />
      <VersionsDialog
        open={dialog === 'versions'}
        onClose={() => setDialog(null)}
        onRestored={(wf) => {
          qc.setQueryData(['workflow', wf.id], wf);
          ed.load(wf);
        }}
      />
      <PublishDialog
        open={dialog === 'publish' || dialog === 'deploy'}
        deploy={dialog === 'deploy'}
        onClose={() => setDialog(null)}
        onPublish={(note) => void publish(note, dialog === 'deploy')}
      />
      {testNodeId ? (
        <NodeTestDialog key={testNodeId} nodeId={testNodeId} open onClose={() => setTestNodeId(null)} onTest={(items, port) => void testNode(items, port)} />
      ) : null}
      <span className="hidden" data-testid="last-saved">
        {relativeTime(workflow.updatedAt)}
      </span>
    </div>
  );
}

function MenuItem({ icon, children, onClick, danger }: { icon: React.ReactNode; children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx('flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] hover:bg-hover', danger ? 'text-bad' : 'text-ink')}
    >
      {icon}
      {children}
    </button>
  );
}
