import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, Command, KeyRound, LayoutTemplate, ListChecks, Play, Plus, Settings, Workflow as WorkflowIcon } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { EditorPage } from './editor/Editor';
import { api, bridge, hasToken, setSessionToken, subscribeEvents } from './lib/api';
import { dispatchEngineEvent, useLive } from './lib/events';
import { relativeTime } from './lib/format';
import { match, navigate, useRoute } from './lib/router';
import { CredentialsPage } from './pages/Credentials';
import { ExecutionsPage } from './pages/Executions';
import { SettingsPage } from './pages/Settings';
import { TemplatesPage } from './pages/Templates';
import { WorkflowsPage } from './pages/Workflows';
import { Button, Card, Input, Label, Toaster, cx, toast } from './components/ui';

export function App() {
  const info = useQuery({ queryKey: ['info'], queryFn: api.info, retry: false });
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, retry: false, enabled: info.isSuccess });
  if (info.isError || me.isError) {
    if (info.data?.mode === 'server' || !hasToken()) return <SignIn needsSetup={info.data?.needsSetup ?? false} serverMode={info.data?.mode === 'server'} />;
    return <Fatal message={((info.error ?? me.error) as Error).message} />;
  }
  if (!info.data || !me.data) return <Splash />;
  return <Shell />;
}

function Splash() {
  return (
    <div className="flex h-full items-center justify-center">
      <img src="./favicon.png" alt="" className="h-12 w-12 animate-pulse" />
    </div>
  );
}

function Fatal({ message }: { message: string }) {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <Card className="max-w-md p-6 text-center">
        <div className="text-[15px] font-semibold">Can’t reach the PulseFlow engine</div>
        <div className="mt-2 text-xs text-muted">{message}</div>
        <Button className="mt-4" onClick={() => window.location.reload()}>
          Retry
        </Button>
      </Card>
    </div>
  );
}

function SignIn({ needsSetup, serverMode }: { needsSetup: boolean; serverMode: boolean }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  if (!serverMode)
    return (
      <div className="flex h-full items-center justify-center p-8">
        <Card className="max-w-md p-6">
          <div className="text-[15px] font-semibold">Open PulseFlow from its launch link</div>
          <p className="mt-2 text-xs leading-relaxed text-muted">
            The local server only accepts requests with its per-launch token. Use the link printed by <code className="text-cyan">pulseflow serve</code> (it
            ends in <code>#token=…</code>), or open the desktop app.
          </p>
        </Card>
      </div>
    );
  const submit = async () => {
    try {
      const r = needsSetup ? await api.setup({ email, password, name }) : await api.login(email, password);
      setSessionToken(r.token);
      window.location.reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div className="flex h-full items-center justify-center p-8">
      <Card className="w-96 p-6">
        <div className="mb-4 flex items-center gap-3">
          <img src="./favicon.png" alt="" className="h-8 w-8" />
          <div>
            <div className="text-[15px] font-semibold">{needsSetup ? 'Create the owner account' : 'Sign in to PulseFlow'}</div>
            <div className="text-xs text-faint">Server mode</div>
          </div>
        </div>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {needsSetup ? (
            <div>
              <Label>Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </div>
          ) : null}
          <div>
            <Label>Email</Label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div>
            <Label hint={needsSetup ? 'at least 10 characters' : undefined}>Password</Label>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          {err ? <div className="text-xs text-bad">{err}</div> : null}
          <Button variant="primary" type="submit" className="w-full">
            {needsSetup ? 'Create account' : 'Sign in'}
          </Button>
        </form>
      </Card>
    </div>
  );
}

const NAV = [
  { path: '/', label: 'Workflows', icon: WorkflowIcon },
  { path: '/templates', label: 'Templates', icon: LayoutTemplate },
  { path: '/executions', label: 'Executions', icon: ListChecks },
  { path: '/credentials', label: 'Credentials', icon: KeyRound },
  { path: '/settings', label: 'Settings', icon: Settings },
];

function Shell() {
  const route = useRoute();
  const qc = useQueryClient();
  const live = useLive();
  const [palette, setPalette] = useState(false);
  const [bell, setBell] = useState(false);
  const notifications = useQuery({ queryKey: ['notifications'], queryFn: api.notifications, refetchInterval: 30_000 });
  const unread = notifications.data?.filter((n) => !n.read).length ?? 0;

  useEffect(
    () =>
      subscribeEvents(
        (e) => {
          dispatchEngineEvent(e);
          if (e.type === 'notification') {
            void qc.invalidateQueries({ queryKey: ['notifications'] });
            if (!bridge) toast.info(e.title, e.body);
          }
        },
        (c) => useLive.getState().setConnected(c),
      ),
    [qc],
  );
  useEffect(() => bridge?.onNavigate((r) => navigate(r)), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const wfMatch = match('/workflows/:id', route);
  const execMatch = match('/executions/:id', route);
  let page: ReactNode;
  if (wfMatch) page = <EditorPage key={wfMatch.id} id={wfMatch.id!} />;
  else if (route.startsWith('/templates')) page = <TemplatesPage />;
  else if (execMatch) page = <ExecutionsPage key={execMatch.id} initialId={execMatch.id!} />;
  else if (route.startsWith('/executions')) page = <ExecutionsPage />;
  else if (route.startsWith('/credentials')) page = <CredentialsPage />;
  else if (route.startsWith('/settings')) page = <SettingsPage />;
  else page = <WorkflowsPage />;
  const activePath = wfMatch ? '/' : (NAV.find((n) => n.path !== '/' && route.startsWith(n.path))?.path ?? '/');

  return (
    <div className="flex h-full" data-testid="app-ready">
      <nav className="flex w-14 shrink-0 flex-col items-center gap-1 border-r border-line bg-panel py-3" aria-label="Main">
        <button type="button" onClick={() => navigate('/')} className="mb-3" title="PulseFlow">
          <img src="./favicon.png" alt="PulseFlow" className="h-8 w-8" />
        </button>
        {NAV.map((n) => (
          <button
            key={n.path}
            type="button"
            title={n.label}
            aria-label={n.label}
            aria-current={activePath === n.path ? 'page' : undefined}
            data-testid={`nav-${n.label.toLowerCase()}`}
            onClick={() => navigate(n.path)}
            className={cx(
              'relative flex h-10 w-10 items-center justify-center rounded-xl transition-colors',
              activePath === n.path ? 'bg-accent/15 text-accent' : 'text-faint hover:bg-hover hover:text-ink',
            )}
          >
            {activePath === n.path ? <span className="absolute top-2 bottom-2 -left-2 w-0.5 rounded bg-accent" /> : null}
            <n.icon size={18} strokeWidth={1.8} />
          </button>
        ))}
        <div className="flex-1" />
        <button
          type="button"
          title="Command palette (Ctrl+K)"
          aria-label="Command palette"
          onClick={() => setPalette(true)}
          className="flex h-10 w-10 items-center justify-center rounded-xl text-faint hover:bg-hover hover:text-ink"
        >
          <Command size={17} />
        </button>
        <div className="relative">
          <button
            type="button"
            title="Notifications"
            aria-label="Notifications"
            onClick={() => {
              setBell((v) => !v);
              if (unread) void api.markNotificationsRead().then(() => qc.invalidateQueries({ queryKey: ['notifications'] }));
            }}
            className="relative flex h-10 w-10 items-center justify-center rounded-xl text-faint hover:bg-hover hover:text-ink"
          >
            <Bell size={17} />
            {unread ? <span className="absolute top-2 right-2 h-2 w-2 rounded-full bg-accent" /> : null}
          </button>
          {bell ? (
            <div
              className="absolute bottom-0 left-12 z-40 max-h-96 w-80 overflow-y-auto rounded-xl border border-line bg-raised p-1.5 shadow-2xl"
              onMouseLeave={() => setBell(false)}
            >
              {notifications.data?.length ? (
                notifications.data.map((n) => (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => (n.workflow_id ? navigate(`/workflows/${n.workflow_id}`) : undefined, setBell(false))}
                    className="block w-full rounded-lg px-2.5 py-2 text-left hover:bg-hover"
                  >
                    <div className="flex items-center justify-between text-[12.5px] font-medium">
                      {n.title}
                      <span className="text-[10.5px] font-normal text-faint">{relativeTime(n.ts)}</span>
                    </div>
                    <div className="line-clamp-2 text-[11.5px] text-muted">{n.body}</div>
                  </button>
                ))
              ) : (
                <div className="px-3 py-4 text-center text-xs text-faint">No notifications</div>
              )}
            </div>
          ) : null}
        </div>
        <span
          className={cx('mt-2 h-2 w-2 rounded-full', live.connected ? 'bg-ok' : 'bg-bad')}
          title={live.connected ? 'Live updates connected' : 'Live updates disconnected — retrying'}
        />
      </nav>
      <main className="flex min-w-0 flex-1 flex-col">{page}</main>
      {palette ? <CommandPalette onClose={() => setPalette(false)} /> : null}
      <Toaster />
    </div>
  );
}

interface PaletteItem {
  id: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  run: () => void | Promise<void>;
}

function CommandPalette({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const workflows = useQuery({ queryKey: ['workflows', ''], queryFn: () => api.workflows() });
  const templates = useQuery({ queryKey: ['templates'], queryFn: api.templates });
  const qc = useQueryClient();
  const items = useMemo<PaletteItem[]>(() => {
    const base: PaletteItem[] = [
      {
        id: 'new',
        label: 'New workflow',
        icon: <Plus size={14} />,
        run: async () => navigate(`/workflows/${(await api.createWorkflow({ name: 'Untitled workflow' })).id}`),
      },
      ...NAV.map((n) => ({ id: `nav-${n.path}`, label: `Go to ${n.label}`, icon: <n.icon size={14} />, run: () => navigate(n.path) })),
      ...(workflows.data ?? []).map((w) => ({
        id: `wf-${w.id}`,
        label: w.name,
        hint: 'workflow',
        icon: <WorkflowIcon size={14} />,
        run: () => navigate(`/workflows/${w.id}`),
      })),
      ...(workflows.data ?? []).map((w) => ({
        id: `run-${w.id}`,
        label: `Run “${w.name}”`,
        hint: 'run draft',
        icon: <Play size={14} />,
        run: async () => {
          const r = await api.run(w.id, { useDraft: true });
          void qc.invalidateQueries({ queryKey: ['executions'] });
          navigate(`/executions/${r.executionId}`);
        },
      })),
      ...(templates.data?.templates ?? []).map((t) => ({
        id: `tpl-${t.id}`,
        label: `${t.id} ${t.name}`,
        hint: 'template',
        icon: <LayoutTemplate size={14} />,
        run: () => navigate('/templates'),
      })),
    ];
    const term = q.toLowerCase().trim();
    return (term ? base.filter((i) => i.label.toLowerCase().includes(term)) : base).slice(0, 50);
  }, [q, workflows.data, templates.data, qc]);
  const choose = (i: PaletteItem | undefined) => {
    if (!i) return;
    onClose();
    void Promise.resolve(i.run()).catch((e: unknown) => toast.error('Command failed', e));
  };
  return (
    <div className="fixed inset-0 z-50 flex justify-center bg-black/50 pt-[14vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="h-fit w-[560px] overflow-hidden rounded-2xl border border-line bg-panel shadow-2xl"
        role="dialog"
        aria-label="Command palette"
        data-testid="command-palette"
      >
        <input
          autoFocus
          value={q}
          onChange={(e) => (setQ(e.target.value), setIdx(0))}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            else if (e.key === 'Enter') choose(items[idx]);
            else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setIdx((i) => (e.key === 'ArrowDown' ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1)));
            }
          }}
          placeholder="Type a command or search…"
          className="h-12 w-full border-b border-line bg-transparent px-4 text-[14px] placeholder:text-faint focus:outline-none"
        />
        <div className="max-h-[50vh] overflow-y-auto p-1.5">
          {items.map((i, k) => (
            <button
              key={i.id}
              type="button"
              onMouseEnter={() => setIdx(k)}
              onClick={() => choose(i)}
              className={cx('flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px]', k === idx ? 'bg-accent/15 text-ink' : 'text-muted')}
            >
              <span className="text-faint">{i.icon}</span>
              <span className="flex-1 truncate">{i.label}</span>
              {i.hint ? <span className="text-[11px] text-faint">{i.hint}</span> : null}
            </button>
          ))}
          {items.length === 0 ? <div className="px-3 py-4 text-center text-xs text-faint">No matches</div> : null}
        </div>
      </div>
    </div>
  );
}
