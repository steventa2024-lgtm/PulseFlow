import type { FsGrant, PermissionGrants, Workflow } from '@pulseflow/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderOpen, History, Plus, ShieldAlert, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, bridge } from '../lib/api';
import { dateTime, relativeTime } from '../lib/format';
import { Badge, Button, IconButton, Input, Modal, Select, Switch, toast } from '../components/ui';
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
      onSaved(wf);
      toast.ok('Permissions saved');
      onClose();
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
  if (!workflow) return null;
  return (
    <Modal
      open={open}
      onClose={onClose}
      width={600}
      testId="versions-dialog"
      title={
        <span className="flex items-center gap-2">
          <History size={16} /> Version history
        </span>
      }
    >
      {!versions.data?.length ? (
        <div className="py-8 text-center text-xs text-muted">No versions yet. Publishing creates an immutable version that triggers run.</div>
      ) : (
        <div className="space-y-1.5">
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

export function PublishDialog({ open, onClose, onPublish }: { open: boolean; onClose: () => void; onPublish: (note: string) => void }) {
  const [note, setNote] = useState('');
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Publish a new version"
      width={480}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" data-testid="publish-confirm" onClick={() => (onPublish(note), setNote(''))}>
            Publish
          </Button>
        </>
      }
    >
      <p className="mb-3 text-xs text-muted">Active triggers always run the published version. Your draft stays editable.</p>
      <Input
        autoFocus
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="What changed? (optional)"
        onKeyDown={(e) => e.key === 'Enter' && onPublish(note)}
      />
    </Modal>
  );
}
