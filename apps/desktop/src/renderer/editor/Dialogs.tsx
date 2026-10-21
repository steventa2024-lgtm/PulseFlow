import type { FsGrant, PermissionGrants, Workflow } from '@pulseflow/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderOpen, History, Plus, ShieldAlert, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, bridge } from '../lib/api';
import { dateTime, relativeTime } from '../lib/format';
import { Badge, Button, IconButton, Input, Label, Modal, Select, Switch, TextArea, toast } from '../components/ui';
import { compareVersions } from './comparison';
import { useEditor } from './store';

export function requiredPermissions(): Set<string> {
  const { nodes, catalog } = useEditor.getState();
  const out = new Set<string>();
  for (const n of nodes) if (!n.data.instance.disabled) for (const p of catalog.get(n.data.instance.type)?.permissions ?? []) out.add(p);
  return out;
}

export function PermissionsDialog({
  open,
  onClose,
  onSaved,
  intent,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: (wf: Workflow) => void;
  intent?: string;
}) {
  const workflow = useEditor((s) => s.workflow);
  const current = useEditor((s) => s.settings?.permissions);
  const [grants, setGrants] = useState<Omit<PermissionGrants, 'confirmedAt'>>({
    fs: [],
    allowPrivateNetwork: false,
    notifications: true,
    email: false,
    advancedNodes: false,
  });
  const [newPath, setNewPath] = useState('');
  const needs = useMemo(() => (open ? requiredPermissions() : new Set<string>()), [open]);
  useEffect(() => {
    if (open && current)
      setGrants({
        fs: current.fs,
        allowPrivateNetwork: current.allowPrivateNetwork,
        notifications: current.notifications,
        email: current.email,
        advancedNodes: current.advancedNodes,
      });
  }, [open, current]);
  if (!workflow) return null;
  const addPath = (p: string, access: FsGrant['access'] = 'read') => {
    if (!p.trim()) return;
    setGrants((g) => ({ ...g, fs: [...g.fs.filter((x) => x.path !== p), { path: p.trim(), access }] }));
    setNewPath('');
  };
  const save = async () => {
    try {
      const wf = await api.setPermissions(workflow.id, grants);
      onClose();
      onSaved(wf);
      toast.ok('Permissions saved');
    } catch (e) {
      toast.error('Could not save permissions', e);
    }
  };
  const Row = ({
    title,
    desc,
    needed,
    checked,
    onChange,
  }: {
    title: string;
    desc: string;
    needed: boolean;
    checked: boolean;
    onChange: (v: boolean) => void;
  }) => (
    <div className="flex items-start justify-between gap-4 rounded-lg border border-line bg-bg/50 p-3">
      <div>
        <div className="flex items-center gap-2 text-[13px] font-medium">
          {title} {needed ? <Badge tone="warn">used by this workflow</Badge> : null}
        </div>
        <div className="mt-0.5 text-xs text-muted">{desc}</div>
      </div>
      <Switch checked={checked} onChange={onChange} label={title} />
    </div>
  );
  return (
    <Modal
      open={open}
      onClose={onClose}
      width={620}
      testId="permissions-dialog"
      title={
        <span className="flex items-center gap-2">
          <ShieldAlert size={16} className="text-warn" /> Review permissions
        </span>
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} data-testid="permissions-save">
            {intent ?? 'Save permissions'}
          </Button>
        </>
      }
    >
      <p className="mb-4 text-xs leading-relaxed text-muted">
        Workflows can only touch what you allow here. Imported workflows always start with no permissions. Files are limited to the folders below (plus
        PulseFlow’s own demo folder); public internet access is allowed, but private-network and localhost addresses are blocked unless you enable them.
      </p>
      <div className="space-y-2.5">
        <div className="rounded-lg border border-line bg-bg/50 p-3">
          <div className="flex items-center gap-2 text-[13px] font-medium">
            Folder access {needs.has('fs.read') || needs.has('fs.write') ? <Badge tone="warn">used by this workflow</Badge> : null}
          </div>
          <div className="mt-2 space-y-1.5">
            {grants.fs.map((g) => (
              <div key={g.path} className="flex items-center gap-1.5">
                <code className="min-w-0 flex-1 truncate rounded bg-raised px-2 py-1.5 font-mono text-[11.5px]" title={g.path}>
                  {g.path}
                </code>
                <Select
                  value={g.access}
                  className="h-7 w-32 text-xs"
                  onChange={(e) =>
                    setGrants((s) => ({ ...s, fs: s.fs.map((x) => (x.path === g.path ? { ...x, access: e.target.value as FsGrant['access'] } : x)) }))
                  }
                >
                  <option value="read">Read only</option>
                  <option value="readwrite">Read & write</option>
                </Select>
                <IconButton label="Remove folder" className="h-7 w-7" onClick={() => setGrants((s) => ({ ...s, fs: s.fs.filter((x) => x.path !== g.path) }))}>
                  <Trash2 size={12} />
                </IconButton>
              </div>
            ))}
            <div className="flex gap-1.5">
              <Input
                value={newPath}
                onChange={(e) => setNewPath(e.target.value)}
                placeholder="Absolute folder path"
                className="h-7 font-mono text-xs"
                onKeyDown={(e) => e.key === 'Enter' && addPath(newPath)}
              />
              {bridge ? (
                <IconButton
                  label="Browse for folder"
                  className="h-7 w-7 border border-line"
                  onClick={async () => {
                    const p = await bridge!.selectFolder('Grant folder access');
                    if (p) addPath(p);
                  }}
                >
                  <FolderOpen size={13} />
                </IconButton>
              ) : null}
              <Button size="sm" icon={<Plus size={12} />} onClick={() => addPath(newPath)}>
                Add
              </Button>
            </div>
          </div>
        </div>
        <Row
          title="Private network & localhost"
          desc="Allow requests to 127.0.0.1, 192.168.x.x, 10.x.x.x and similar. Cloud metadata addresses stay blocked."
          needed={needs.has('network')}
          checked={grants.allowPrivateNetwork}
          onChange={(v) => setGrants((g) => ({ ...g, allowPrivateNetwork: v }))}
        />
        <Row
          title="Send email"
          desc="Allow Send Email nodes to deliver through your configured SMTP credential."
          needed={needs.has('email')}
          checked={grants.email}
          onChange={(v) => setGrants((g) => ({ ...g, email: v }))}
        />
        <Row
          title="Desktop notifications"
          desc="Allow Notify nodes to show system notifications."
          needed={needs.has('notify')}
          checked={grants.notifications}
          onChange={(v) => setGrants((g) => ({ ...g, notifications: v }))}
        />
        <Row
          title="Advanced nodes (shell / code)"
          desc="Runs commands or scripts with your user account’s rights. Not a security sandbox. Also requires Settings → Advanced nodes."
          needed={needs.has('advanced')}
          checked={grants.advancedNodes}
          onChange={(v) => setGrants((g) => ({ ...g, advancedNodes: v }))}
        />
      </div>
    </Modal>
  );
}

export function VersionsDialog({ open, onClose, onRestored }: { open: boolean; onClose: () => void; onRestored: (wf: Workflow) => void }) {
  const workflow = useEditor((s) => s.workflow);
  const qc = useQueryClient();
  const versions = useQuery({ queryKey: ['versions', workflow?.id], queryFn: () => api.versions(workflow!.id), enabled: open && !!workflow });
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('draft');
  const draft = useEditor();
  const current = { graph: draft.graph(), settings: draft.settings };
  if (!workflow) return null;
  const source = versions.data?.find((v) => v.id === (from || workflow.publishedVersionId || versions.data[0]?.id));
  const target = to === 'draft' ? (current.settings ? { graph: current.graph, settings: current.settings } : null) : versions.data?.find((v) => v.id === to);
  const changes = source && target ? compareVersions(source, target) : [];
  return (
    <Modal
      open={open}
      onClose={onClose}
      width={780}
      testId="versions-dialog"
      title={
        <span className="flex items-center gap-2">
          <History size={16} /> Version history
        </span>
      }
    >
      {versions.isError ? (
        <p role="alert" className="text-xs text-bad">
          Could not load version history. Close and try again.
        </p>
      ) : versions.isPending ? (
        <p className="text-xs text-muted">Loading version history…</p>
      ) : !versions.data?.length ? (
        <div className="py-8 text-center text-xs text-muted">No versions yet. Publishing creates an immutable version that triggers run.</div>
      ) : (
        <div className="space-y-4">
          <div className="rounded-xl border border-line bg-bg/50 p-3" data-testid="version-comparison">
            <div className="mb-3 text-xs font-semibold">Compare versions</div>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-muted">
                From
                <Select aria-label="Compare from" value={source?.id ?? ''} onChange={(e) => setFrom(e.target.value)} className="mt-1">
                  {versions.data.map((v) => (
                    <option key={v.id} value={v.id}>
                      v{v.versionNumber} · {v.note || 'Published'}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="text-xs text-muted">
                To
                <Select aria-label="Compare to" value={to} onChange={(e) => setTo(e.target.value)} className="mt-1">
                  <option value="draft">Current draft (includes unsaved edits)</option>
                  {versions.data.map((v) => (
                    <option key={v.id} value={v.id}>
                      v{v.versionNumber}
                    </option>
                  ))}
                </Select>
              </label>
            </div>
            <div className="mt-3 max-h-52 space-y-1 overflow-y-auto text-xs" aria-live="polite">
              {changes.length ? (
                changes.map((c, i) => (
                  <div key={i} className="flex items-start gap-2 rounded-lg bg-raised px-2 py-1.5">
                    <Badge tone={c.kind === 'Added' ? 'ok' : c.kind === 'Removed' ? 'bad' : 'violet'}>{c.kind}</Badge>
                    <span className="min-w-0 break-words">
                      {c.area}: {c.name}
                      {c.fields?.length ? <span className="text-faint"> · {c.fields.join(', ')}</span> : null}
                    </span>
                  </div>
                ))
              ) : (
                <p className="text-muted">No differences in nodes, connections or execution settings.</p>
              )}
            </div>
            <p className="mt-2 text-[11px] text-faint">Changed fields are listed without revealing stored values. Permission grants are reviewed separately.</p>
          </div>
          {versions.data.map((v) => (
            <div key={v.id} className="flex items-center gap-3 rounded-lg border border-line bg-bg/50 px-3 py-2.5">
              <div className="w-10 text-[13px] font-semibold">v{v.versionNumber}</div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-xs">
                  {v.id === workflow.publishedVersionId ? <Badge tone="ok">live</Badge> : null}
                  <span className="truncate text-ink">{v.note || 'No note'}</span>
                </div>
                <div className="text-[11px] text-faint">
                  {dateTime(v.createdAt)} · {relativeTime(v.createdAt)} · {v.graph.nodes.length} nodes ·{' '}
                  <span className="font-mono">{v.checksum.slice(0, 10)}</span>
                </div>
              </div>
              <Button
                size="sm"
                onClick={async () => {
                  try {
                    const wf = await api.restore(workflow.id, v.id);
                    onRestored(wf);
                    void qc.invalidateQueries({ queryKey: ['versions', workflow.id] });
                    toast.ok(`Restored v${v.versionNumber} into the draft`, 'Publish to make it live.');
                    onClose();
                  } catch (e) {
                    toast.error('Restore failed', e);
                  }
                }}
              >
                Restore to draft
              </Button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

export function PublishDialog({
  open,
  onClose,
  onPublish,
  deploy = false,
}: {
  open: boolean;
  onClose: () => void;
  onPublish: (note: string) => void;
  deploy?: boolean;
}) {
  const [note, setNote] = useState('');
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={deploy ? 'Deploy locally' : 'Publish a new version'}
      width={480}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" data-testid="publish-confirm" onClick={() => (onPublish(note), setNote(''))}>
            {deploy ? 'Deploy locally' : 'Publish'}
          </Button>
        </>
      }
    >
      <p className="mb-3 text-xs leading-relaxed text-muted">
        {deploy
          ? 'Validate and save an immutable version, then activate its triggers on this computer. Schedules, webhooks and file watchers may start executing immediately. This is local deployment.'
          : 'Active triggers always run the published version. Your draft stays editable.'}
      </p>
      <Input
        autoFocus
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="What changed? (optional)"
        aria-label="Version note"
        onKeyDown={(e) => e.key === 'Enter' && onPublish(note)}
      />
    </Modal>
  );
}

export function NodeTestDialog({
  nodeId,
  open,
  onClose,
  onTest,
}: {
  nodeId: string;
  open: boolean;
  onClose: () => void;
  onTest: (items: { json: Record<string, unknown> }[], inputPort?: string) => void;
}) {
  const node = useEditor((s) => s.nodes.find((n) => n.id === nodeId)?.data.instance);
  const entry = useEditor((s) => (node ? s.catalog.get(node.type) : undefined));
  const [input, setInput] = useState('[\n  { "json": {} }\n]');
  const [port, setPort] = useState('');
  const [error, setError] = useState('');
  if (!node || !entry) return null;
  const submit = () => {
    try {
      const parsed: unknown = JSON.parse(input);
      if (
        !Array.isArray(parsed) ||
        !parsed.length ||
        parsed.length > 1000 ||
        parsed.some((v) => !v || typeof v !== 'object' || !v.json || typeof v.json !== 'object' || Array.isArray(v.json))
      )
        throw new Error('Enter 1–1,000 items shaped as { "json": { ... } }.');
      onTest(parsed as { json: Record<string, unknown> }[], port || entry.inputs[0]?.name);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Test node · ${node.name}`}
      testId="node-test-dialog"
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} data-testid="node-test-confirm">
            Execute node
          </Button>
        </>
      }
    >
      <p className="mb-3 text-xs leading-relaxed text-muted">
        Executes this node with the sample input below and records a test execution. Upstream and downstream nodes are excluded; references to their outputs
        will be unavailable. Existing permissions still apply.
      </p>
      <div className="mb-4 rounded-lg border border-warn/30 bg-warn/10 p-3 text-xs text-warn">
        {entry.sideEffects || 'This is a real execution. Configured file, network, notification or other side effects can occur.'}
      </div>
      {entry.inputs.length > 1 ? (
        <label className="mb-3 block text-xs text-muted">
          Input port
          <Select className="mt-1" value={port || entry.inputs[0]?.name} onChange={(e) => setPort(e.target.value)}>
            {entry.inputs.map((p) => (
              <option key={p.name} value={p.name}>
                {p.label || p.name}
              </option>
            ))}
          </Select>
        </label>
      ) : null}
      <Label>Sample items (JSON)</Label>
      <TextArea
        aria-label="Node test input"
        className="min-h-44"
        value={input}
        onChange={(e) => {
          setInput(e.target.value);
          setError('');
        }}
      />
      {error ? (
        <p role="alert" className="mt-2 text-xs text-bad">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}
