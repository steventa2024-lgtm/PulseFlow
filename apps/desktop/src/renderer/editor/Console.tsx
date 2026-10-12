import { TERMINAL_EXECUTION_STATES, type ExecutionStep, type Item } from '@pulseflow/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronUp, History, ListTree, OctagonX, RotateCcw, ScrollText, Square, TriangleAlert } from 'lucide-react';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { api, type ExecutionDetail } from '../lib/api';
import { clockTime, duration, executionDuration, relativeTime, stateStyle } from '../lib/format';
import { Badge, Button, Empty, IconButton, JsonView, StateBadge, Tabs, cx, toast } from '../components/ui';
import { useEditor, type ConsoleTab, type NodeRunState } from './store';

export function deriveRunStates(steps: ExecutionStep[]): Record<string, NodeRunState> {
  const out: Record<string, NodeRunState> = {};
  for (const s of steps) {
    const prev = out[s.nodeId];
    if (prev && prev.attempt > s.attempt) continue;
    const items = s.output ? Object.values(s.output).reduce((a, l) => a + l.length, 0) : null;
    out[s.nodeId] = { state: s.state, attempt: s.attempt, durationMs: s.durationMs, items, error: s.error?.message ?? null };
  }
  return out;
}

export function useExecution(id: string | null) {
  return useQuery({
    queryKey: ['execution', id],
    queryFn: () => api.execution(id!),
    enabled: !!id,
    refetchInterval: (q) => (q.state.data && TERMINAL_EXECUTION_STATES.includes(q.state.data.state) ? false : 1500),
  });
}

export function ExecutionConsole({ workflowId, onRetried }: { workflowId: string; onRetried: (id: string) => void }) {
  const { executionId, consoleTab, consoleOpen, ioNodeId } = useEditor();
  const { setConsole, setExecution } = useEditor.getState();
  const exec = useExecution(executionId);
  const [height, setHeight] = useState(300);
  const drag = useRef<{ y: number; h: number } | null>(null);
  const failed = exec.data?.steps.filter((s) => s.state === 'failed' || s.state === 'timed_out') ?? [];
  const logCount = exec.data?.steps.reduce((a, s) => a + s.logs.length, 0) ?? 0;

  const tabs: { id: ConsoleTab; label: ReactNode; count?: number }[] = [
    { id: 'timeline', label: <TabLabel icon={<ListTree size={13} />}>Timeline</TabLabel> },
    { id: 'io', label: <TabLabel icon={<ChevronDown size={13} className="-rotate-90" />}>Node IO</TabLabel> },
    { id: 'logs', label: <TabLabel icon={<ScrollText size={13} />}>Logs</TabLabel>, count: logCount },
    { id: 'errors', label: <TabLabel icon={<TriangleAlert size={13} />}>Errors</TabLabel>, count: failed.length + (exec.data?.error && !failed.length ? 1 : 0) },
    { id: 'history', label: <TabLabel icon={<History size={13} />}>History</TabLabel> },
  ];

  return (
    <section className="flex shrink-0 flex-col border-t border-line bg-panel" style={{ height: consoleOpen ? height : 40 }} aria-label="Execution console" data-testid="console">
      {consoleOpen ? (
        <div
          className="h-1 cursor-row-resize hover:bg-accent/40"
          onPointerDown={(e) => {
            drag.current = { y: e.clientY, h: height };
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => drag.current && setHeight(Math.max(160, Math.min(window.innerHeight * 0.7, drag.current.h - (e.clientY - drag.current.y))))}
          onPointerUp={() => (drag.current = null)}
        />
      ) : null}
      <div className="flex h-9 shrink-0 items-center gap-3 px-3">
        <Tabs tabs={tabs} value={consoleTab} onChange={(t) => setConsole({ tab: t, open: true })} />
        <div className="flex-1" />
        {exec.data ? <ExecutionHeader exec={exec.data} onRetried={onRetried} /> : <span className="text-xs text-faint">No run selected</span>}
        <IconButton label={consoleOpen ? 'Collapse console' : 'Expand console'} onClick={() => setConsole({ open: !consoleOpen })}>
          {consoleOpen ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
        </IconButton>
      </div>
      {consoleOpen ? (
        <div className="min-h-0 flex-1 overflow-hidden border-t border-line">
          {consoleTab === 'history' ? (
            <HistoryTab workflowId={workflowId} selected={executionId} onSelect={(id) => (setExecution(id), setConsole({ tab: 'timeline' }))} />
          ) : !exec.data ? (
            <Empty title="Run the workflow to see results here">Press Ctrl+Enter or the Run button. Each node’s inputs, outputs, logs and errors are recorded for every run.</Empty>
          ) : consoleTab === 'timeline' ? (
            <TimelineTab exec={exec.data} onPick={(nodeId) => setConsole({ tab: 'io', ioNodeId: nodeId })} />
          ) : consoleTab === 'io' ? (
            <IoTab exec={exec.data} nodeId={ioNodeId} onPick={(nodeId) => setConsole({ ioNodeId: nodeId })} />
          ) : consoleTab === 'logs' ? (
            <LogsTab exec={exec.data} />
          ) : (
            <ErrorsTab exec={exec.data} onRetried={onRetried} onPick={(nodeId) => setConsole({ tab: 'io', ioNodeId: nodeId })} />
          )}
        </div>
      ) : null}
    </section>
  );
}

function TabLabel({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="flex items-center gap-1.5">
      {icon}
      {children}
    </span>
  );
}

function ExecutionHeader({ exec, onRetried }: { exec: ExecutionDetail; onRetried: (id: string) => void }) {
  const terminal = TERMINAL_EXECUTION_STATES.includes(exec.state);
  const qc = useQueryClient();
  return (
    <div className="flex items-center gap-2 text-xs" data-testid="execution-header" data-state={exec.state}>
      <StateBadge state={exec.state} />
      <span className="text-faint">
        {exec.mode} · {duration(executionDuration(exec))} · <span className="font-mono">{exec.id}</span>
      </span>
      {!terminal ? (
        <Button size="sm" variant="danger" icon={<Square size={11} />} onClick={() => void api.cancel(exec.id).then(() => qc.invalidateQueries({ queryKey: ['execution', exec.id] }))}>
          Stop
        </Button>
      ) : exec.state !== 'succeeded' ? (
        <RetryButtons id={exec.id} onRetried={onRetried} />
      ) : null}
    </div>
  );
}

function RetryButtons({ id, onRetried }: { id: string; onRetried: (id: string) => void }) {
  const retry = async (from: 'start' | 'failed') => {
    try {
      const r = await api.retry(id, from);
      onRetried(r.executionId);
    } catch (e) {
      toast.error('Retry failed', e);
    }
  };
  return (
    <>
      <Button size="sm" variant="secondary" icon={<RotateCcw size={11} />} onClick={() => void retry('failed')}>
        Retry from failed
      </Button>
      <Button size="sm" variant="ghost" onClick={() => void retry('start')}>
        From start
      </Button>
    </>
  );
}

function TimelineTab({ exec, onPick }: { exec: ExecutionDetail; onPick: (nodeId: string) => void }) {
  const start = Date.parse(exec.startedAt ?? exec.queuedAt);
  const end = exec.finishedAt ? Date.parse(exec.finishedAt) : Date.now();
  const total = Math.max(1, end - start);
  const steps = [...exec.steps].sort((a, b) => (a.startedAt ?? '9').localeCompare(b.startedAt ?? '9') || a.attempt - b.attempt);
  return (
    <div className="h-full overflow-y-auto px-3 py-2" data-testid="timeline">
      {exec.error ? (
        <div className="mb-2 flex items-start gap-2 rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-xs text-bad">
          <OctagonX size={14} className="mt-px shrink-0" />
          <span>
            <b className="font-semibold">{exec.error.code}</b> — {exec.error.message}
          </span>
        </div>
      ) : null}
      <table className="w-full text-xs">
        <tbody>
          {steps.map((s) => {
            const st = stateStyle(s.state);
            const s0 = s.startedAt ? Date.parse(s.startedAt) - start : 0;
            const w = s.durationMs ?? (s.state === 'running' && s.startedAt ? Date.now() - Date.parse(s.startedAt) : 0);
            const items = s.output ? Object.values(s.output).reduce((a, l) => a + l.length, 0) : null;
            return (
              <tr key={s.id} className="cursor-pointer hover:bg-hover/60" onClick={() => onPick(s.nodeId)} data-testid={`timeline-row-${s.nodeName}`} data-state={s.state}>
                <td className="w-52 py-1 pr-2">
                  <div className="flex items-center gap-2">
                    <span className={cx('h-2 w-2 shrink-0 rounded-full', st.dot)} />
                    <span className="truncate">{s.nodeName}</span>
                    {s.attempt > 1 ? <Badge tone="warn">try {s.attempt}</Badge> : null}
                  </div>
                </td>
                <td className={cx('w-24 py-1 pr-2', st.text)}>{st.label}</td>
                <td className="py-1 pr-3">
                  <div className="relative h-4 rounded bg-bg">
                    {s.state !== 'skipped' ? (
                      <div className={cx('absolute top-0.5 bottom-0.5 rounded-sm', st.dot)} style={{ left: `${(s0 / total) * 100}%`, width: `max(3px, ${(w / total) * 100}%)`, opacity: 0.85 }} />
                    ) : null}
                  </div>
                </td>
                <td className="w-20 py-1 text-right text-faint">{items !== null ? `${items} item${items === 1 ? '' : 's'}` : ''}</td>
                <td className="w-20 py-1 text-right font-mono text-faint">{s.state === 'retrying' && s.retryInMs ? `retry ${duration(s.retryInMs)}` : duration(s.durationMs)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ItemsView({ items }: { items: Item[] }) {
  const [mode, setMode] = useState<'table' | 'json'>('table');
  const columns = useMemo(() => {
    const cols = new Set<string>();
    for (const it of items.slice(0, 200)) for (const k of Object.keys(it.json)) cols.add(k);
    return [...cols].slice(0, 30);
  }, [items]);
  if (!items.length) return <div className="p-3 text-xs text-faint">No items.</div>;
  const cell = (v: unknown) => (v === null || v === undefined ? <span className="text-faint">∅</span> : typeof v === 'object' ? <span className="text-violet">{JSON.stringify(v).slice(0, 120)}</span> : String(v).slice(0, 200));
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-faint">
        {items.length} item{items.length === 1 ? '' : 's'}
        <div className="flex-1" />
        <Tabs
          value={mode}
          onChange={setMode}
          tabs={[
            { id: 'table', label: 'Table' },
            { id: 'json', label: 'JSON' },
          ]}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-3 pb-3">
        {mode === 'json' ? (
          <JsonView value={items.slice(0, 500).map((i) => i.json)} />
        ) : (
          <table className="w-full border-separate border-spacing-0 text-[11.5px]">
            <thead className="sticky top-0 bg-panel">
              <tr>
                <th className="border-b border-line px-2 py-1 text-left font-medium text-faint">#</th>
                {columns.map((c) => (
                  <th key={c} className="border-b border-line px-2 py-1 text-left font-medium whitespace-nowrap text-muted">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.slice(0, 500).map((it, i) => (
                <tr key={i} className="hover:bg-hover/50">
                  <td className="border-b border-line/50 px-2 py-1 text-faint">{i}</td>
                  {columns.map((c) => (
                    <td key={c} className="max-w-72 truncate border-b border-line/50 px-2 py-1 font-mono">
                      {cell(it.json[c])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function IoTab({ exec, nodeId, onPick }: { exec: ExecutionDetail; nodeId: string | null; onPick: (id: string) => void }) {
  const latest = Object.values(
    exec.steps.reduce<Record<string, ExecutionStep>>((acc, s) => {
      if (!acc[s.nodeId] || acc[s.nodeId]!.attempt < s.attempt) acc[s.nodeId] = s;
      return acc;
    }, {}),
  ).sort((a, b) => (a.startedAt ?? '9').localeCompare(b.startedAt ?? '9'));
  const step = latest.find((s) => s.nodeId === nodeId) ?? latest.find((s) => s.state !== 'skipped') ?? latest[0];
  const [side, setSide] = useState<'output' | 'input'>('output');
  const ports = step ? Object.keys((side === 'output' ? step.output : step.input) ?? {}) : [];
  const [port, setPort] = useState<string | null>(null);
  const activePort = port && ports.includes(port) ? port : (ports[0] ?? null);
  const items = step && activePort ? ((side === 'output' ? step.output : step.input)?.[activePort] ?? []) : [];
  return (
    <div className="flex h-full" data-testid="node-io">
      <div className="w-52 shrink-0 overflow-y-auto border-r border-line py-1">
        {latest.map((s) => (
          <button key={s.nodeId} type="button" onClick={() => onPick(s.nodeId)} className={cx('flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-hover', step?.nodeId === s.nodeId && 'bg-raised text-ink')}>
            <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full', stateStyle(s.state).dot)} />
            <span className="truncate">{s.nodeName}</span>
          </button>
        ))}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        {step ? (
          <>
            <div className="flex items-center gap-2 border-b border-line px-3 py-1">
              <Tabs
                value={side}
                onChange={setSide}
                tabs={[
                  { id: 'input', label: 'Input' },
                  { id: 'output', label: 'Output' },
                ]}
              />
              {ports.length > 1 ? (
                <div className="flex items-center gap-1">
                  {ports.map((p) => (
                    <button key={p} type="button" onClick={() => setPort(p)} className={cx('rounded px-1.5 py-0.5 text-[11px]', activePort === p ? 'bg-accent/15 text-accent' : 'text-faint hover:text-ink')}>
                      {p}
                    </button>
                  ))}
                </div>
              ) : null}
              {step.truncated ? <Badge tone="warn">truncated for display</Badge> : null}
              <div className="flex-1" />
              <span className="text-[11px] text-faint">
                {stateStyle(step.state).label} · {duration(step.durationMs)}
              </span>
            </div>
            <div className="min-h-0 flex-1">{step.error ? <div className="m-3 rounded-lg border border-bad/30 bg-bad/10 p-2 text-xs text-bad">{step.error.code}: {step.error.message}</div> : <ItemsView items={items} />}</div>
          </>
        ) : (
          <Empty title="No node data" />
        )}
      </div>
    </div>
  );
}

function LogsTab({ exec }: { exec: ExecutionDetail }) {
  const [level, setLevel] = useState<'all' | 'warn' | 'error'>('all');
  const rows = exec.steps
    .flatMap((s) => s.logs.map((l) => ({ ...l, node: s.nodeName })))
    .filter((l) => level === 'all' || (level === 'warn' ? l.level === 'warn' || l.level === 'error' : l.level === 'error'))
    .sort((a, b) => a.ts.localeCompare(b.ts));
  const color = { debug: 'text-faint', info: 'text-muted', warn: 'text-warn', error: 'text-bad' } as const;
  return (
    <div className="flex h-full flex-col" data-testid="logs">
      <div className="flex items-center gap-2 border-b border-line px-3 py-1">
        <Tabs
          value={level}
          onChange={setLevel}
          tabs={[
            { id: 'all', label: 'All' },
            { id: 'warn', label: 'Warnings' },
            { id: 'error', label: 'Errors' },
          ]}
        />
        <span className="text-[11px] text-faint">Secrets are redacted before logs are stored.</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-1.5 font-mono text-[11.5px] leading-5">
        {rows.length === 0 ? <div className="py-4 text-center font-sans text-xs text-faint">No log lines.</div> : null}
        {rows.map((l, i) => (
          <div key={i} className="flex gap-3">
            <span className="shrink-0 text-faint">{clockTime(l.ts)}</span>
            <span className={cx('w-10 shrink-0 uppercase', color[l.level])}>{l.level}</span>
            <span className="w-40 shrink-0 truncate text-accent">{l.node}</span>
            <span className={cx('min-w-0 break-words', color[l.level])}>{l.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ErrorsTab({ exec, onRetried, onPick }: { exec: ExecutionDetail; onRetried: (id: string) => void; onPick: (id: string) => void }) {
  const failed = exec.steps.filter((s) => s.error);
  if (!failed.length && !exec.error) return <Empty title="No errors in this run" />;
  return (
    <div className="h-full space-y-2 overflow-y-auto p-3" data-testid="errors">
      {exec.error ? (
        <div className="rounded-lg border border-bad/30 bg-bad/10 p-3 text-xs">
          <div className="font-semibold text-bad">
            Run {exec.state.replace('_', ' ')}: {exec.error.code}
          </div>
          <div className="mt-1 text-ink">{exec.error.message}</div>
          <div className="mt-2 flex gap-2">
            <RetryButtons id={exec.id} onRetried={onRetried} />
          </div>
        </div>
      ) : null}
      {failed.map((s) => (
        <button key={s.id} type="button" onClick={() => onPick(s.nodeId)} className="block w-full rounded-lg border border-line bg-bg/60 p-3 text-left text-xs hover:border-line-strong">
          <div className="flex items-center gap-2">
            <span className="font-medium">{s.nodeName}</span>
            <Badge tone={s.state === 'retrying' ? 'warn' : 'bad'}>
              {s.state === 'retrying' ? 'retried' : s.state} · attempt {s.attempt}
            </Badge>
            <span className="ml-auto text-faint">{clockTime(s.finishedAt)}</span>
          </div>
          <div className="mt-1 font-mono text-[11.5px] text-bad">{s.error!.code}</div>
          <div className="mt-0.5 text-muted">{s.error!.message}</div>
        </button>
      ))}
    </div>
  );
}

function HistoryTab({ workflowId, selected, onSelect }: { workflowId: string; selected: string | null; onSelect: (id: string) => void }) {
  const list = useQuery({ queryKey: ['executions', { workflowId }], queryFn: () => api.executions({ workflowId, limit: 100 }), refetchInterval: 5000 });
  if (!list.data?.length) return <Empty title="No runs yet" />;
  return (
    <div className="h-full overflow-y-auto" data-testid="history">
      <table className="w-full text-xs">
        <tbody>
          {list.data.map((e) => (
            <tr key={e.id} onClick={() => onSelect(e.id)} className={cx('cursor-pointer border-b border-line/50 hover:bg-hover/60', selected === e.id && 'bg-raised')}>
              <td className="px-3 py-1.5">
                <StateBadge state={e.state} />
              </td>
              <td className="px-2 py-1.5 text-muted">{e.mode}</td>
              <td className="px-2 py-1.5 text-muted">{relativeTime(e.queuedAt)}</td>
              <td className="px-2 py-1.5 font-mono text-faint">{duration(executionDuration(e))}</td>
              <td className="px-2 py-1.5 text-bad">{e.error?.message ?? ''}</td>
              <td className="px-3 py-1.5 text-right font-mono text-faint">{e.id}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
