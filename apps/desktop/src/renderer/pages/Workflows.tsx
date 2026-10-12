import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LayoutTemplate, Plus, Search, Upload, Workflow as WorkflowIcon, Zap } from 'lucide-react';
import { useRef, useState } from 'react';
import { api } from '../lib/api';
import { duration, executionDuration, relativeTime } from '../lib/format';
import { navigate } from '../lib/router';
import { Badge, Button, Card, Empty, Input, StateBadge, toast } from '../components/ui';

export function WorkflowsPage() {
  const [q, setQ] = useState('');
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['workflows', q], queryFn: () => api.workflows(q || undefined), refetchInterval: 10_000 });
  const stats = useQuery({ queryKey: ['executions', 'stats'], queryFn: () => api.executionStats(), refetchInterval: 10_000 });
  const fileRef = useRef<HTMLInputElement>(null);

  const create = async () => {
    const wf = await api.createWorkflow({ name: 'Untitled workflow' });
    void qc.invalidateQueries({ queryKey: ['workflows'] });
    navigate(`/workflows/${wf.id}`);
  };

  const importFile = async (file: File) => {
    try {
      const bundle = JSON.parse(await file.text()) as unknown;
      const r = await api.importBundle(bundle);
      void qc.invalidateQueries({ queryKey: ['workflows'] });
      toast.ok(`Imported ${r.workflows.length} workflow${r.workflows.length === 1 ? '' : 's'}`, 'Imported workflows are inactive and have no permissions until you review them.');
    } catch (e) {
      toast.error('Import failed', e);
    }
  };

  const s = stats.data ?? {};
  const total = Object.values(s).reduce((a, b) => a + b, 0);
  const active = list.data?.filter((w) => w.active).length ?? 0;

  return (
    <div className="h-full overflow-y-auto" data-testid="workflows-page">
      <div className="mx-auto max-w-6xl px-8 py-7">
        <div className="mb-6 flex items-end justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold">Workflows</h1>
            <p className="mt-1 text-[13px] text-muted">Automations that run on this computer. Nothing leaves your machine unless a workflow sends it.</p>
          </div>
          <div className="flex gap-2">
            <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={(e) => e.target.files?.[0] && void importFile(e.target.files[0])} />
            <Button icon={<Upload size={14} />} onClick={() => fileRef.current?.click()}>
              Import
            </Button>
            <Button icon={<LayoutTemplate size={14} />} onClick={() => navigate('/templates')}>
              Templates
            </Button>
            <Button variant="primary" icon={<Plus size={14} />} onClick={() => void create()} data-testid="new-workflow">
              New workflow
            </Button>
          </div>
        </div>

        <div className="mb-6 grid grid-cols-4 gap-3">
          <Stat label="Workflows" value={list.data?.length ?? '—'} />
          <Stat label="Active" value={active} tone="text-ok" />
          <Stat label="Runs recorded" value={total} />
          <Stat label="Failed runs" value={(s.failed ?? 0) + (s.timed_out ?? 0)} tone={(s.failed ?? 0) > 0 ? 'text-bad' : undefined} />
        </div>

        <div className="relative mb-3 w-80">
          <Search size={14} className="absolute top-2 left-2.5 text-faint" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search workflows…" className="pl-8" />
        </div>

        {list.data && list.data.length === 0 ? (
          <Card>
            <Empty
              icon={<WorkflowIcon size={20} />}
              title={q ? 'No workflows match your search' : 'No workflows yet'}
              action={
                q ? null : (
                  <div className="flex gap-2">
                    <Button variant="primary" icon={<LayoutTemplate size={14} />} onClick={() => navigate('/templates')}>
                      Browse templates
                    </Button>
                    <Button icon={<Plus size={14} />} onClick={() => void create()}>
                      Start blank
                    </Button>
                  </div>
                )
              }
            >
              Start from one of the offline templates — each runs immediately with bundled sample data — or build your own on the canvas.
            </Empty>
          </Card>
        ) : (
          <Card className="overflow-hidden">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-line text-left text-[11px] text-faint uppercase">
                  <th className="px-4 py-2.5 font-medium">Name</th>
                  <th className="px-3 py-2.5 font-medium">Status</th>
                  <th className="px-3 py-2.5 font-medium">Last run</th>
                  <th className="px-3 py-2.5 font-medium">Nodes</th>
                  <th className="px-4 py-2.5 text-right font-medium">Updated</th>
                </tr>
              </thead>
              <tbody>
                {(list.data ?? []).map((w) => (
                  <tr key={w.id} className="cursor-pointer border-b border-line/60 last:border-0 hover:bg-hover/50" onClick={() => navigate(`/workflows/${w.id}`)} data-testid={`workflow-row-${w.name}`}>
                    <td className="px-4 py-3">
                      <div className="font-medium">{w.name}</div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-faint">
                        {w.templateId ? <Badge>{w.templateId}</Badge> : null}
                        {w.tags.map((t) => (
                          <Badge key={t} tone={t === 'demo' ? 'cyan' : 'neutral'}>
                            {t}
                          </Badge>
                        ))}
                        <span className="truncate">{w.description}</span>
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      {w.active ? (
                        <Badge tone="ok">
                          <Zap size={10} /> Active
                        </Badge>
                      ) : w.publishedVersionId ? (
                        <Badge>Published</Badge>
                      ) : (
                        <Badge>Draft</Badge>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      {w.lastExecution ? (
                        <div className="flex items-center gap-2">
                          <StateBadge state={w.lastExecution.state} />
                          <span className="text-[11px] text-faint">
                            {relativeTime(w.lastExecution.queuedAt)} · {duration(executionDuration(w.lastExecution))}
                          </span>
                        </div>
                      ) : (
                        <span className="text-xs text-faint">Never</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-muted">{w.nodeCount}</td>
                    <td className="px-4 py-3 text-right text-xs text-faint">{relativeTime(w.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: string | undefined }) {
  return (
    <Card className="px-4 py-3">
      <div className="text-[11px] font-medium tracking-wide text-faint uppercase">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${tone ?? ''}`}>{value}</div>
    </Card>
  );
}
