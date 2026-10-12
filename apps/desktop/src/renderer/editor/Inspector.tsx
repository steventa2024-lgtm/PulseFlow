import type { CredentialMeta, NodeCatalogEntry, NodeInstance, ValidationIssue, VariableValue } from '@pulseflow/contracts';
import { useQuery } from '@tanstack/react-query';
import { Copy, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { api, type TriggerStatus } from '../lib/api';
import { relativeTime } from '../lib/format';
import { CATEGORY_COLORS, NodeIcon } from '../lib/icons';
import { Badge, Button, IconButton, Input, Label, Select, Switch, Tabs, TextArea, toast } from '../components/ui';
import { isParamVisible, ParamField } from './ParamField';
import { useEditor } from './store';

export function Inspector({ issues, onReviewPermissions }: { issues: ValidationIssue[]; onReviewPermissions: () => void }) {
  const selected = useEditor(useShallow((s) => s.nodes.filter((n) => n.selected)));
  const credentials = useQuery({ queryKey: ['credentials'], queryFn: api.credentials });
  const node = selected.length === 1 ? selected[0]!.data.instance : null;
  return (
    <aside className="flex w-[340px] shrink-0 flex-col border-l border-line bg-panel" aria-label="Inspector" data-testid="inspector">
      {node ? (
        <NodeInspector key={node.id} node={node} credentials={credentials.data ?? []} issues={issues.filter((i) => i.nodeId === node.id)} />
      ) : selected.length > 1 ? (
        <div className="p-4 text-xs text-muted">{selected.length} nodes selected. Press Delete to remove, Ctrl+D to duplicate.</div>
      ) : (
        <WorkflowInspector onReviewPermissions={onReviewPermissions} />
      )}
    </aside>
  );
}

function NodeInspector({ node, credentials, issues }: { node: NodeInstance; credentials: CredentialMeta[]; issues: ValidationIssue[] }) {
  const entry = useEditor((s) => s.catalog.get(node.type));
  const { updateNode, setParam } = useEditor.getState();
  const [tab, setTab] = useState<'params' | 'settings' | 'info'>('params');
  if (!entry) return <div className="p-4 text-xs text-bad">Unknown node type “{node.type}”. It may come from a newer PulseFlow version.</div>;
  const color = CATEGORY_COLORS[entry.category] ?? '#3b82f6';
  const paramIssue = (name: string) => issues.find((i) => i.param === name)?.message;
  const general = issues.filter((i) => !i.param);
  return (
    <>
      <div className="border-b border-line p-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl" style={{ background: `${color}1f`, color }}>
            <NodeIcon name={entry.icon} size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <input
              aria-label="Node name"
              data-testid="node-name-input"
              value={node.name}
              onChange={(e) => updateNode(node.id, { name: e.target.value })}
              className="w-full rounded-md border border-transparent bg-transparent px-1 py-0.5 text-[14px] font-semibold hover:border-line focus:border-accent focus:outline-none"
            />
            <div className="flex items-center gap-1.5 px-1 text-[11px] text-faint">
              {entry.displayName}
              {entry.status === 'requires-setup' ? <Badge tone="warn">Requires setup</Badge> : entry.status === 'beta' ? <Badge tone="violet">Beta</Badge> : null}
              {entry.risk === 'advanced' ? <Badge tone="bad">Advanced</Badge> : null}
            </div>
          </div>
        </div>
        <Tabs
          className="mt-3"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'params', label: 'Parameters', count: issues.length },
            { id: 'settings', label: 'Settings' },
            { id: 'info', label: 'Info' },
          ]}
        />
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {general.map((i, k) => (
          <div key={k} className={i.severity === 'error' ? 'rounded-lg border border-bad/30 bg-bad/10 p-2 text-xs text-bad' : 'rounded-lg border border-warn/30 bg-warn/10 p-2 text-xs text-warn'}>
            {i.message}
          </div>
        ))}
        {tab === 'params' ? (
          entry.parameters.length === 0 ? (
            <div className="text-xs text-faint">This node has no parameters.</div>
          ) : (
            entry.parameters.filter((p) => isParamVisible(p, node.parameters)).map((p) => <ParamField key={p.name} def={p} value={node.parameters[p.name]} onChange={(v) => setParam(node.id, p.name, v)} credentials={credentials} issue={paramIssue(p.name)} />)
          )
        ) : null}
        {tab === 'settings' ? <NodeSettings node={node} entry={entry} /> : null}
        {tab === 'info' ? (
          <div className="space-y-3 text-xs leading-relaxed text-muted">
            <p>{entry.description}</p>
            {entry.sideEffects ? (
              <div>
                <div className="mb-1 font-medium text-ink">Side effects</div>
                {entry.sideEffects}
              </div>
            ) : null}
            <div>
              <div className="mb-1 font-medium text-ink">Permissions</div>
              <div className="flex flex-wrap gap-1">{entry.permissions.length ? entry.permissions.map((p) => <Badge key={p}>{p}</Badge>) : <span className="text-faint">None</span>}</div>
            </div>
            {entry.docs ? <p className="whitespace-pre-wrap">{entry.docs}</p> : null}
            <div className="font-mono text-[11px] text-faint">
              {node.type} v{node.typeVersion} · id {node.id}
            </div>
            <div className="rounded-lg border border-line bg-bg p-2.5 text-[11px]">
              <div className="mb-1 font-medium text-ink">Expressions</div>
              Use <code className="text-cyan">{'{{ $json.field }}'}</code> for the current item, <code className="text-cyan">{"{{ $node['Name'].json.x }}"}</code> for another node, <code className="text-cyan">{'{{ $vars.name }}'}</code> for workflow variables and{' '}
              <code className="text-cyan">{'{{ $now }}'}</code>. Expressions are parsed safely; arbitrary JavaScript is never evaluated.
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
}

function NodeSettings({ node, entry }: { node: NodeInstance; entry: NodeCatalogEntry }) {
  const { updateNode } = useEditor.getState();
  const retry = node.retry ?? {};
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs font-medium text-muted">Disabled</div>
          <div className="text-[11px] text-faint">Items pass through unchanged.</div>
        </div>
        <Switch checked={!!node.disabled} onChange={(v) => updateNode(node.id, { disabled: v })} label="Disabled" />
      </div>
      <div>
        <Label>On error</Label>
        <Select value={node.onError ?? 'stop'} onChange={(e) => updateNode(node.id, { onError: e.target.value as NodeInstance['onError'] })}>
          <option value="stop">Stop the workflow</option>
          <option value="continue">Continue with the input items</option>
          {entry.errorOutput !== false ? <option value="route">Route to the “error” output</option> : null}
        </Select>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label>Max attempts</Label>
          <Input type="number" min={1} max={20} value={retry.maxAttempts ?? 1} onChange={(e) => updateNode(node.id, { retry: { ...retry, maxAttempts: Math.max(1, Math.min(20, Number(e.target.value) || 1)) } })} />
        </div>
        <div>
          <Label>First delay (ms)</Label>
          <Input type="number" min={0} value={retry.initialDelayMs ?? 1000} onChange={(e) => updateNode(node.id, { retry: { ...retry, initialDelayMs: Math.max(0, Number(e.target.value) || 0) } })} />
        </div>
        <div>
          <Label>Backoff ×</Label>
          <Input type="number" min={1} max={10} step={0.5} value={retry.multiplier ?? 2} onChange={(e) => updateNode(node.id, { retry: { ...retry, multiplier: Math.max(1, Math.min(10, Number(e.target.value) || 1)) } })} />
        </div>
        <div>
          <Label>Timeout (ms)</Label>
          <Input type="number" min={1} placeholder="default" value={node.timeoutMs ?? ''} onChange={(e) => updateNode(node.id, e.target.value ? { timeoutMs: Math.max(1, Number(e.target.value)) } : { timeoutMs: undefined })} />
        </div>
      </div>
      <div>
        <Label>Notes</Label>
        <TextArea value={node.notes ?? ''} className="font-sans text-[13px]" placeholder="Why this node exists…" onChange={(e) => updateNode(node.id, { notes: e.target.value })} />
      </div>
    </div>
  );
}

function WorkflowInspector({ onReviewPermissions }: { onReviewPermissions: () => void }) {
  const { name, description, settings, workflow } = useEditor();
  const { setMeta, setSettings } = useEditor.getState();
  const triggers = useQuery({ queryKey: ['triggers', workflow?.id], queryFn: () => api.triggers(workflow!.id), enabled: !!workflow?.publishedVersionId, refetchInterval: 10_000 });
  const [newVar, setNewVar] = useState('');
  if (!settings || !workflow) return null;
  const vars = settings.variables;
  const setVar = (k: string, v: VariableValue) => setSettings({ variables: { ...vars, [k]: v } });
  const perms = settings.permissions;
  return (
    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
      <div>
        <div className="mb-3 text-xs font-semibold tracking-wide text-muted uppercase">Workflow</div>
        <Label>Name</Label>
        <Input value={name} onChange={(e) => setMeta({ name: e.target.value })} />
        <div className="mt-3">
          <Label>Description</Label>
          <TextArea className="min-h-16 font-sans text-[13px]" value={description} onChange={(e) => setMeta({ description: e.target.value })} />
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-semibold tracking-wide text-muted uppercase">Variables</span>
          <span className="text-[11px] text-faint">
            use as <code className="text-cyan">{'{{ $vars.name }}'}</code>
          </span>
        </div>
        <div className="space-y-1.5" data-testid="variables">
          {Object.entries(vars).map(([k, v]) => (
            <div key={k} className="flex items-center gap-1.5">
              <span className="w-28 shrink-0 truncate font-mono text-[11.5px] text-muted" title={k}>
                {k}
              </span>
              <Input data-testid={`var-${k}`} value={String(v)} onChange={(e) => setVar(k, typeof v === 'number' && !Number.isNaN(Number(e.target.value)) ? Number(e.target.value) : typeof v === 'boolean' ? e.target.value === 'true' : e.target.value)} className="h-7 font-mono text-xs" />
              <IconButton
                label={`Remove ${k}`}
                className="h-7 w-7"
                onClick={() => {
                  const { [k]: _removed, ...rest } = vars;
                  setSettings({ variables: rest });
                }}
              >
                <Trash2 size={12} />
              </IconButton>
            </div>
          ))}
          <form
            className="flex gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(newVar)) return toast.error('Variable names use letters, digits and _');
              setVar(newVar, '');
              setNewVar('');
            }}
          >
            <Input value={newVar} onChange={(e) => setNewVar(e.target.value)} placeholder="newVariable" className="h-7 font-mono text-xs" />
            <IconButton label="Add variable" type="submit" className="h-7 w-7 border border-line">
              <Plus size={13} />
            </IconButton>
          </form>
        </div>
      </div>

      <div>
        <div className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">Execution</div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label>Timezone</Label>
            <Input value={settings.timezone} onChange={(e) => setSettings({ timezone: e.target.value })} />
          </div>
          <div>
            <Label>Timeout (min)</Label>
            <Input type="number" min={1} value={Math.round(settings.executionTimeoutMs / 60_000)} onChange={(e) => setSettings({ executionTimeoutMs: Math.max(1, Number(e.target.value) || 1) * 60_000 })} />
          </div>
          <div>
            <Label>Concurrent runs</Label>
            <Input type="number" min={1} max={64} value={settings.maxConcurrentRuns} onChange={(e) => setSettings({ maxConcurrentRuns: Math.max(1, Math.min(64, Number(e.target.value) || 1)) })} />
          </div>
          <div>
            <Label>Save run data</Label>
            <Select value={settings.saveExecutionData} onChange={(e) => setSettings({ saveExecutionData: e.target.value as 'all' | 'errors' | 'none' })}>
              <option value="all">All runs</option>
              <option value="errors">Failed runs only</option>
              <option value="none">Metadata only</option>
            </Select>
          </div>
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-semibold tracking-wide text-muted uppercase">Permissions</span>
          <Button size="sm" variant="ghost" icon={<ShieldCheck size={13} />} onClick={onReviewPermissions}>
            Review
          </Button>
        </div>
        <ul className="space-y-1 text-xs text-muted">
          <li>Folders: {perms.fs.length ? perms.fs.map((g) => `${g.path} (${g.access})`).join(', ') : 'app demo folder only'}</li>
          <li>Private network / localhost: {perms.allowPrivateNetwork ? 'allowed' : 'blocked'}</li>
          <li>Send email: {perms.email ? 'allowed' : 'blocked'}</li>
          <li>Advanced nodes: {perms.advancedNodes ? 'allowed' : 'blocked'}</li>
          <li className="text-faint">{perms.confirmedAt ? `Reviewed ${relativeTime(perms.confirmedAt)}` : 'Not reviewed yet'}</li>
        </ul>
      </div>

      {workflow.publishedVersionId ? <TriggerList workflowId={workflow.id} triggers={triggers.data ?? []} onRotated={() => void triggers.refetch()} /> : null}
    </div>
  );
}

function TriggerList({ workflowId, triggers, onRotated }: { workflowId: string; triggers: TriggerStatus[]; onRotated: () => void }) {
  const nodes = useEditor((s) => s.nodes);
  if (!triggers.length) return null;
  return (
    <div>
      <div className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">Triggers (published)</div>
      <div className="space-y-2">
        {triggers.map((t) => (
          <div key={t.nodeId} className="rounded-lg border border-line bg-bg/60 p-2.5 text-xs">
            <div className="font-medium">{nodes.find((n) => n.id === t.nodeId)?.data.instance.name ?? t.nodeId}</div>
            <div className="mt-1 space-y-0.5 text-[11px] text-faint">
              {t.nextRunAt ? <div>Next run {relativeTime(t.nextRunAt)}</div> : null}
              <div>Last fired {relativeTime(t.lastFiredAt)}</div>
              {t.lastError ? <div className="text-bad">{t.lastError}</div> : null}
            </div>
            {t.webhookUrl ? (
              <div className="mt-2 flex items-center gap-1">
                <code className="min-w-0 flex-1 truncate rounded bg-raised px-1.5 py-1 font-mono text-[10.5px] text-cyan" title={t.webhookUrl}>
                  {t.webhookUrl}
                </code>
                <IconButton label="Copy webhook URL" className="h-6 w-6" onClick={() => void navigator.clipboard.writeText(t.webhookUrl!).then(() => toast.ok('Webhook URL copied'))}>
                  <Copy size={12} />
                </IconButton>
                <IconButton
                  label="Rotate webhook URL"
                  className="h-6 w-6"
                  onClick={async () => {
                    await api.rotateWebhook(workflowId, t.nodeId);
                    toast.ok('Webhook URL rotated', 'The previous URL no longer works.');
                    onRotated();
                  }}
                >
                  <RefreshCw size={12} />
                </IconButton>
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
