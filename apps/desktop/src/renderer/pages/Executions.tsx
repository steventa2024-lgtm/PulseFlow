import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Inbox, RotateCcw, Search, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api } from '../lib/api';
import { useEngineEvents } from '../lib/events';
import { clockTime, dateTime, duration, executionDuration, relativeTime, stateStyle } from '../lib/format';
import { navigate } from '../lib/router';
import { Badge, Button, Card, Empty, Input, JsonView, StateBadge, Tabs, cx, toast } from '../components/ui';

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'running,queued,waiting', label: 'In progress' },
  { id: 'succeeded', label: 'Succeeded' },
  { id: 'failed,timed_out', label: 'Failed' },
  { id: 'cancelled', label: 'Cancelled' },
] as const;

export function ExecutionsPage({ initialId }: { initialId?: string }) {
  const qc = useQueryClient();
  const [state, setState] = useState<(typeof FILTERS)[number]['id']>('all');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string | null>(initialId ?? null);
  const [view, setView] = useState<'runs' | 'dlq'>('runs');
  const list = useQuery({
    queryKey: ['executions', { state, q }],
    queryFn: () => api.executions({ ...(state !== 'all' ? { state } : {}), ...(q ? { search: q } : {}), limit: 200 }),
  });
  const dlq = useQuery({ queryKey: ['dead-letters'], queryFn: api.deadLetters, enabled: view === 'dlq' });
  useEngineEvents(
    (e) => {
      if (e.type === 'execution.updated') {
        void qc.invalidateQueries({ queryKey: ['executions'] });
        if (e.executionId === selected) void qc.invalidateQueries({ queryKey: ['execution', selected] });
      }
    },
    [selected],
  );
  const detail = useQuery({ queryKey: ['execution', selected], queryFn: () => api.execution(selected!), enabled: !!selected });

  return (
    <div className="flex h-full" data-testid="executions-page">
      <div className="flex w-[560px] shrink-0 flex-col border-r border-line">
        <div className="space-y-3 border-b border-line p-4">
          <div className="flex items-center justify-between">
            <h1 className="text-lg font-semibold">Executions</h1>
            <Tabs
              value={view}
              onChange={setView}
              tabs={[
                { id: 'runs', label: 'Runs' },
                { id: 'dlq', label: 'Dead letters' },
              ]}
            />
          </div>
          {view === 'runs' ? (
            <>
              <Tabs value={state} onChange={setState} tabs={FILTERS.map((f) => ({ id: f.id, label: f.label }))} />
              <div className="relative">
                <Search size={14} className="absolute top-2 left-2.5 text-faint" />
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by workflow name, execution id or error…" className="pl-8" />
              </div>
            </>
          ) : (
            <p className="text-xs text-muted">
              Trigger payloads that did not finish: the queue was full, or the trigger run failed. Replay runs the published workflow again. If that replay
              fails, the payload comes back here.
            </p>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {view === 'dlq' ? (
            dlq.data?.length ? (
              dlq.data.map((d) => (
                <div key={d.id} className="border-b border-line/60 px-4 py-3 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-faint">{d.id}</span>
                    <span className="ml-auto text-faint">{relativeTime(d.created_at)}</span>
                  </div>
                  <div className="mt-1 text-bad">{d.reason}</div>
                  <div className="mt-2 flex gap-2">
                    <Button
                      size="sm"
                      icon={<RotateCcw size={12} />}
                      onClick={async () => (await api.replayDeadLetter(d.id), toast.ok('Replayed'), void qc.invalidateQueries({ queryKey: ['dead-letters'] }))}
                    >
                      Replay
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Trash2 size={12} />}
                      onClick={async () => (await api.deleteDeadLetter(d.id), void qc.invalidateQueries({ queryKey: ['dead-letters'] }))}
                    >
                      Discard
                    </Button>
                  </div>
                </div>
              ))
            ) : (
              <Empty icon={<Inbox size={18} />} title="No dead letters" />
            )
          ) : list.data?.length ? (
            list.data.map((e) => (
              <button
                key={e.id}
                type="button"
                onClick={() => setSelected(e.id)}
                className={cx('block w-full border-b border-line/60 px-4 py-2.5 text-left hover:bg-hover/50', selected === e.id && 'bg-raised')}
                data-testid={`execution-row-${e.id}`}
              >
                <div className="flex items-center gap-2">
                  <StateBadge state={e.state} />
                  <span className="truncate text-[13px] font-medium">{e.workflowName}</span>
                  <span className="ml-auto shrink-0 text-[11px] text-faint">{relativeTime(e.queuedAt)}</span>
                </div>
                <div className="mt-1 flex items-center gap-2 text-[11px] text-faint">
                  <Badge>{e.mode}</Badge>
                  <span>{duration(executionDuration(e))}</span>
                  <span className="font-mono">{e.id}</span>
                  {e.error ? <span className="truncate text-bad">{e.error.message}</span> : null}
                </div>
              </button>
            ))
          ) : (
            <Empty title="No executions" />
          )}
        </div>
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto">
        {detail.data ? (
          <div className="p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-semibold">{detail.data.workflowName}</h2>
                  <StateBadge state={detail.data.state} />
                </div>
                <div className="mt-1 text-xs text-faint">
                  {dateTime(detail.data.queuedAt)} · {detail.data.mode} · {duration(executionDuration(detail.data))} · engine {detail.data.engineVersion} ·{' '}
                  <span className="font-mono">{detail.data.id}</span>
                </div>
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => navigate(`/workflows/${detail.data!.workflowId}`)}>
                  Open workflow
                </Button>
                {detail.data.state !== 'succeeded' && ['failed', 'cancelled', 'timed_out'].includes(detail.data.state) ? (
                  <Button
                    size="sm"
                    variant="primary"
                    icon={<RotateCcw size={12} />}
                    onClick={async () => setSelected((await api.retry(detail.data!.id, 'failed')).executionId)}
                  >
                    Retry from failed
                  </Button>
                ) : null}
              </div>
            </div>
            {detail.data.error ? (
              <div className="mt-4 rounded-lg border border-bad/30 bg-bad/10 p-3 text-xs text-bad">
                <b>{detail.data.error.code}</b> — {detail.data.error.message}
              </div>
            ) : null}
            <Card className="mt-4 overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-line text-left text-[11px] text-faint uppercase">
                    <th className="px-3 py-2 font-medium">Node</th>
                    <th className="px-3 py-2 font-medium">State</th>
                    <th className="px-3 py-2 font-medium">Started</th>
                    <th className="px-3 py-2 font-medium">Duration</th>
                    <th className="px-3 py-2 font-medium">Output</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.data.steps.map((s) => (
                    <tr key={s.id} className="border-b border-line/50 align-top last:border-0">
                      <td className="px-3 py-2">
                        <div className="font-medium">{s.nodeName}</div>
                        <div className="text-[11px] text-faint">
                          {s.nodeType}
                          {s.attempt > 1 ? ` · attempt ${s.attempt}` : ''}
                        </div>
                      </td>
                      <td className={cx('px-3 py-2', stateStyle(s.state).text)}>{stateStyle(s.state).label}</td>
                      <td className="px-3 py-2 text-faint">{clockTime(s.startedAt)}</td>
                      <td className="px-3 py-2 font-mono text-faint">{duration(s.durationMs)}</td>
                      <td className="px-3 py-2">
                        {s.error ? (
                          <span className="text-bad">
                            {s.error.code}: {s.error.message}
                          </span>
                        ) : s.output ? (
                          <details>
                            <summary className="cursor-pointer text-muted">
                              {Object.entries(s.output)
                                .map(([p, l]) => `${p}: ${l.length}`)
                                .join(' · ')}
                            </summary>
                            <div className="mt-2 w-[min(560px,50vw)]">
                              <JsonView
                                value={Object.fromEntries(Object.entries(s.output).map(([p, l]) => [p, l.slice(0, 20).map((i) => i.json)]))}
                                maxHeight={260}
                              />
                            </div>
                          </details>
                        ) : (
                          <span className="text-faint">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </div>
        ) : (
          <Empty title="Select an execution">Each run keeps a full record of node inputs, outputs, logs and errors (secrets are redacted).</Empty>
        )}
      </div>
    </div>
  );
}
