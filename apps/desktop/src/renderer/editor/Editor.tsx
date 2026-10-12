import { Background, BackgroundVariant, Controls, MiniMap, ReactFlow, ReactFlowProvider, useReactFlow, type Connection, type IsValidConnection } from '@xyflow/react';
import type { NodeCatalogEntry, ValidationIssue, Workflow } from '@pulseflow/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, CircleAlert, Copy, Download, History, Loader2, MoreHorizontal, Play, Redo2, Rocket, Trash2, Undo2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { ApiError, api } from '../lib/api';
import { useEngineEvents } from '../lib/events';
import { relativeTime } from '../lib/format';
import { navigate } from '../lib/router';
import { Badge, Button, IconButton, Spinner, Switch, cx, toast } from '../components/ui';
import { deriveRunStates, ExecutionConsole, useExecution } from './Console';
import { PermissionsDialog, PublishDialog, requiredPermissions, VersionsDialog } from './Dialogs';
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
  const { nodes, edges, dirty, workflow, name, executionId, past, future } = useEditor();
  const ed = useEditor.getState();
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [dialog, setDialog] = useState<null | 'permissions' | 'versions' | 'publish' | 'activate-permissions'>(null);
  const [menu, setMenu] = useState(false);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const loadedFor = useRef<string | null>(null);

  useEffect(() => {
    if (catalogQuery.data) ed.setCatalog(catalogQuery.data);
  }, [catalogQuery.data, ed]);

  useEffect(() => {
    if (wfQuery.data && loadedFor.current !== `${wfQuery.data.id}:${wfQuery.dataUpdatedAt}`) {
      loadedFor.current = `${wfQuery.data.id}:${wfQuery.dataUpdatedAt}`;
      ed.load(wfQuery.data);
      requestAnimationFrame(() => void rf.fitView({ padding: 0.25, maxZoom: 1.1 }));
      void api.executions({ workflowId: wfQuery.data.id, limit: 1 }).then((l) => l[0] && !useEditor.getState().executionId && ed.setExecution(l[0].id));
    }
  }, [wfQuery.data, wfQuery.dataUpdatedAt, ed, rf]);

  const exec = useExecution(executionId);
  useEffect(() => {
    if (exec.data && exec.data.id === useEditor.getState().executionId) ed.setRunStates(deriveRunStates(exec.data.steps));
  }, [exec.data, ed]);

  useEngineEvents(
    (e) => {
      const cur = useEditor.getState().executionId;
      if ((e.type === 'step.updated' || e.type === 'execution.updated') && e.executionId === cur) {
        if (e.type === 'step.updated') ed.setRunState(e.nodeId, { state: e.state, attempt: e.attempt, durationMs: e.durationMs ?? null, error: e.error?.message ?? null });
        void qc.invalidateQueries({ queryKey: ['execution', cur] });
      }
      if (e.type === 'execution.updated' && e.workflowId === id) void qc.invalidateQueries({ queryKey: ['executions', { workflowId: id }] });
    },
    [id],
  );

  const save = useCallback(async (): Promise<Workflow | null> => {
    const s = useEditor.getState();
    if (!s.workflow) return null;
    if (!s.dirty) return s.workflow;
    setSaving(true);
    const snapshot = { nodes: s.nodes, edges: s.edges, settings: s.settings, name: s.name, description: s.description };
    try {
      const { permissions: _p, errorWorkflowId, ...settings } = s.settings!;
      const wf = await api.updateWorkflow(s.workflow.id, {
        name: s.name.trim() || 'Untitled workflow',
        description: s.description,
        draft: s.graph(),
        settings: { ...settings, ...(errorWorkflowId ? { errorWorkflowId } : {}) },
        baseRevision: s.revision,
      });
      const now = useEditor.getState();
      const unchanged = now.nodes === snapshot.nodes && now.edges === snapshot.edges && now.settings === snapshot.settings && now.name === snapshot.name && now.description === snapshot.description;
      useEditor.setState({ workflow: wf, revision: wf.draftRevision, dirty: !unchanged });
      qc.setQueryData(['workflow', wf.id], wf);
      void qc.invalidateQueries({ queryKey: ['workflows'] });
      return wf;
    } catch (e) {
      if (e instanceof ApiError && e.code === 'REVISION_CONFLICT') toast.error('This workflow was changed elsewhere', 'Reload to get the latest draft. Your unsaved edits are still on screen.');
      else toast.error('Save failed', e);
      return null;
    } finally {
      setSaving(false);
    }
  }, [qc]);

  // Autosave shortly after edits settle.
  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(() => void save(), 1200);
    return () => clearTimeout(t);
  }, [dirty, nodes, edges, name, save]);

  // Live validation of the draft.
  useEffect(() => {
    if (!workflow) return;
    const t = setTimeout(() => {
      void api
        .validate(workflow.id, useEditor.getState().graph())
        .then((r) => setIssues(r.issues))
        .catch(() => undefined);
    }, 500);
    return () => clearTimeout(t);
  }, [workflow, nodes, edges]);

  const run = useCallback(async () => {
    const wf = await save();
    if (!wf) return;
    setRunning(true);
    try {
      const r = await api.run(wf.id, { useDraft: true });
      ed.setExecution(r.executionId);
      ed.setConsole({ tab: 'timeline', open: true });
      void qc.invalidateQueries({ queryKey: ['executions'] });
    } catch (e) {
      toast.error('Run failed to start', e);
    } finally {
      setRunning(false);
    }
  }, [save, ed, qc]);

  const publish = async (note: string) => {
    setDialog(null);
    const wf = await save();
    if (!wf) return;
    try {
      const v = await api.publish(wf.id, note);
      toast.ok(`Published v${v.versionNumber}`, wf.active ? 'Active triggers now use this version.' : undefined);
      const fresh = await api.workflow(wf.id);
      useEditor.setState({ workflow: fresh });
      void qc.invalidateQueries({ queryKey: ['versions', wf.id] });
      void qc.invalidateQueries({ queryKey: ['triggers', wf.id] });
    } catch (e) {
      toast.error('Publish blocked', e instanceof ApiError && e.code === 'WORKFLOW_INVALID' ? 'Fix the validation errors first.' : e);
    }
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
          pos = rf.screenToFlowPosition({ x: (bounds?.left ?? 0) + (bounds?.width ?? 800) / 2 - 114, y: (bounds?.top ?? 0) + (bounds?.height ?? 600) / 2 - 30 });
        }
      }
      ed.addNode(entry, pos, position ? null : from?.id);
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
  }, [save, run, ed]);

  const isValidConnection: IsValidConnection = useCallback((c) => c.source !== c.target, []);
  const errors = issues.filter((i) => i.severity === 'error');
  const catalog = useMemo(() => catalogQuery.data ?? [], [catalogQuery.data]);
  const triggers = useMemo(() => catalog.filter((c) => ['core.manualTrigger', 'core.scheduleTrigger', 'core.webhookTrigger'].includes(c.type)), [catalog]);

  if (wfQuery.isError) return <div className="p-8 text-sm text-bad">Could not load workflow: {(wfQuery.error as Error).message}</div>;
  if (!workflow || workflow.id !== id) return <div className="flex h-full items-center justify-center"><Spinner size={20} /></div>;

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col" data-testid="editor">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-panel px-3">
        <IconButton label="Back to workflows" onClick={() => navigate('/')}>
          <ArrowLeft size={16} />
        </IconButton>
        <input
          aria-label="Workflow name"
          data-testid="workflow-name"
          value={name}
          onChange={(e) => ed.setMeta({ name: e.target.value })}
          className="w-72 truncate rounded-md border border-transparent bg-transparent px-1.5 py-1 text-[14px] font-semibold hover:border-line focus:border-accent focus:outline-none"
        />
        <span className="flex items-center gap-1 text-[11px] text-faint" data-testid="save-state">
          {saving ? (
            <>
              <Loader2 size={12} className="animate-spin" /> Saving…
            </>
          ) : dirty ? (
            'Unsaved changes'
          ) : (
            <>
              <CheckCircle2 size={12} className="text-ok" /> Saved
            </>
          )}
        </span>
        {workflow.publishedVersionId ? <Badge tone="ok">published</Badge> : <Badge>draft only</Badge>}
        <div className="flex-1" />
        <IconButton label="Undo (Ctrl+Z)" disabled={!past.length} onClick={ed.undo}>
          <Undo2 size={15} />
        </IconButton>
        <IconButton label="Redo (Ctrl+Y)" disabled={!future.length} onClick={ed.redo}>
          <Redo2 size={15} />
        </IconButton>
        <div className="relative">
          <button
            type="button"
            data-testid="validation"
            onClick={() => setIssuesOpen((v) => !v)}
            className={cx('flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs', errors.length ? 'text-bad hover:bg-bad/10' : issues.length ? 'text-warn hover:bg-warn/10' : 'text-ok hover:bg-hover')}
          >
            {issues.length ? <CircleAlert size={14} /> : <CheckCircle2 size={14} />}
            {errors.length ? `${errors.length} error${errors.length > 1 ? 's' : ''}` : issues.length ? `${issues.length} warning${issues.length > 1 ? 's' : ''}` : 'Valid'}
          </button>
          {issuesOpen && issues.length ? (
            <div className="absolute top-9 right-0 z-30 w-96 rounded-xl border border-line bg-raised p-1.5 shadow-2xl">
              {issues.map((i, k) => (
                <button
                  key={k}
                  type="button"
                  className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-hover"
                  onClick={() => {
                    if (i.nodeId) {
                      useEditor.setState((s) => ({ nodes: s.nodes.map((n) => ({ ...n, selected: n.id === i.nodeId })) }));
                      const n = rf.getNode(i.nodeId);
                      if (n) void rf.setCenter(n.position.x + 114, n.position.y + 30, { zoom: 1, duration: 300 });
                    }
                    setIssuesOpen(false);
                  }}
                >
                  <CircleAlert size={13} className={cx('mt-px shrink-0', i.severity === 'error' ? 'text-bad' : 'text-warn')} />
                  <span>{i.message}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <Button icon={<History size={14} />} variant="ghost" onClick={() => setDialog('versions')}>
          Versions
        </Button>
        <Button icon={<Rocket size={14} />} onClick={() => setDialog('publish')} disabled={errors.length > 0} data-testid="publish" title={errors.length ? 'Fix validation errors to publish' : 'Publish a version'}>
          Publish
        </Button>
        <label className="flex items-center gap-2 rounded-lg border border-line px-2.5 py-1 text-xs text-muted" title="Active workflows run on their triggers">
          Active
          <Switch checked={workflow.active} onChange={(v) => void toggleActive(v)} label="Active" />
        </label>
        <Button variant="primary" icon={running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} onClick={() => void run()} data-testid="run" title="Run the draft (Ctrl+Enter)">
          Run
        </Button>
        <div className="relative">
          <IconButton label="More actions" onClick={() => setMenu((v) => !v)}>
            <MoreHorizontal size={16} />
          </IconButton>
          {menu ? (
            <div className="absolute top-9 right-0 z-30 w-52 rounded-xl border border-line bg-raised p-1 shadow-2xl" onMouseLeave={() => setMenu(false)}>
              <MenuItem icon={<Copy size={14} />} onClick={async () => (setMenu(false), navigate(`/workflows/${(await api.duplicateWorkflow(workflow.id)).id}`))}>
                Duplicate
              </MenuItem>
              <MenuItem icon={<Download size={14} />} onClick={async () => (setMenu(false), await save(), downloadJson(`${workflow.name.replace(/[^\w-]+/g, '_')}.pulseflow.json`, await api.exportBundle([workflow.id])))}>
                Export (no secrets)
              </MenuItem>
              <MenuItem
                icon={<Trash2 size={14} />}
                danger
                onClick={async () => {
                  setMenu(false);
                  if (!window.confirm(`Delete “${workflow.name}”? Its run history is deleted too.`)) return;
                  await api.deleteWorkflow(workflow.id);
                  void qc.invalidateQueries({ queryKey: ['workflows'] });
                  navigate('/');
                }}
              >
                Delete
              </MenuItem>
            </div>
          ) : null}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <Library catalog={catalog} onAdd={(e) => addAt(e)} />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="relative min-h-0 flex-1" onDragOver={(e) => (e.preventDefault(), (e.dataTransfer.dropEffect = 'move'))} onDrop={onDrop} data-testid="canvas">
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
              defaultEdgeOptions={{ type: 'pf' }}
            >
              <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} color="#1e2a3c" />
              <Controls showInteractive={false} position="bottom-left" />
              <MiniMap pannable zoomable position="bottom-right" nodeColor="#223047" maskColor="rgb(11 15 22 / 0.7)" style={{ width: 160, height: 100 }} />
            </ReactFlow>
            {nodes.length === 0 ? (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="pointer-events-auto rounded-2xl border border-line bg-panel/90 p-6 text-center shadow-2xl backdrop-blur" data-testid="empty-canvas">
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
        <Inspector issues={issues} onReviewPermissions={() => setDialog('permissions')} />
      </div>

      <PermissionsDialog
        open={dialog === 'permissions' || dialog === 'activate-permissions'}
        intent={dialog === 'activate-permissions' ? 'Save & activate' : undefined}
        onClose={() => setDialog(null)}
        onSaved={(wf) => {
          useEditor.setState((s) => ({ workflow: wf, settings: s.settings ? { ...s.settings, permissions: wf.settings.permissions } : wf.settings }));
          if (dialog === 'activate-permissions') void doActivate();
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
      <PublishDialog open={dialog === 'publish'} onClose={() => setDialog(null)} onPublish={(note) => void publish(note)} />
      <span className="hidden" data-testid="last-saved">
        {relativeTime(workflow.updatedAt)}
      </span>
    </div>
  );
}

function MenuItem({ icon, children, onClick, danger }: { icon: React.ReactNode; children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" onClick={onClick} className={cx('flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] hover:bg-hover', danger ? 'text-bad' : 'text-ink')}>
      {icon}
      {children}
    </button>
  );
}
