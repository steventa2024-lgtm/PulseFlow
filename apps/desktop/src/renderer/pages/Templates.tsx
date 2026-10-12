import type { TemplateSummary } from '@pulseflow/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, FlaskConical, Globe, Plug, Search, ShieldCheck, WifiOff } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api, bridge } from '../lib/api';
import { navigate } from '../lib/router';
import { Badge, Button, Card, Input, Label, Modal, Switch, Tabs, cx, toast } from '../components/ui';

const PERMISSION_TEXT: Record<string, string> = {
  'fs.read': 'Read files in the folders listed below',
  'fs.write': 'Create or change files in the folders listed below',
  network: 'Make HTTP requests to the internet',
  'network.private': 'Reach localhost / your private network',
  notify: 'Show desktop notifications',
  email: 'Send email through your SMTP account',
  kv: 'Remember small values between runs',
  subworkflow: 'Call other workflows',
  advanced: 'Run shell commands or code',
};

export function TemplatesPage() {
  const list = useQuery({ queryKey: ['templates'], queryFn: api.templates });
  const [tier, setTier] = useState<'all' | 'A' | 'B'>('all');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<TemplateSummary | null>(null);
  const items = useMemo(() => {
    const term = q.toLowerCase();
    return (list.data?.templates ?? []).filter((t) => (tier === 'all' || t.tier === tier) && (!term || `${t.name} ${t.description} ${t.category} ${t.tags.join(' ')}`.toLowerCase().includes(term)));
  }, [list.data, tier, q]);

  return (
    <div className="h-full overflow-y-auto" data-testid="templates-page">
      <div className="mx-auto max-w-6xl px-8 py-7">
        <h1 className="text-xl font-semibold">Templates</h1>
        <p className="mt-1 mb-5 max-w-3xl text-[13px] text-muted">
          <b className="text-ink">Offline</b> templates run immediately with bundled sample files and need no accounts. <b className="text-ink">Connected</b> templates need your own account or local service to run live; each also has a clearly
          labelled demo mode that talks to PulseFlow’s built-in local fixture server instead of the real service.
        </p>
        <div className="mb-4 flex items-center gap-3">
          <Tabs
            value={tier}
            onChange={setTier}
            tabs={[
              { id: 'all', label: 'All', count: list.data?.templates.length },
              { id: 'A', label: 'Offline', count: list.data?.templates.filter((t) => t.tier === 'A').length },
              { id: 'B', label: 'Connected', count: list.data?.templates.filter((t) => t.tier === 'B').length },
            ]}
          />
          <div className="relative w-72">
            <Search size={14} className="absolute top-2 left-2.5 text-faint" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search templates…" className="pl-8" />
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          {items.map((t) => (
            <Card key={t.id} className="flex cursor-pointer flex-col p-4 transition-colors hover:border-line-strong" onClick={() => setOpen(t)} data-testid={`template-card-${t.id}`}>
              <div className="mb-2 flex items-center gap-1.5">
                <Badge tone={t.tier === 'A' ? 'ok' : 'accent'}>
                  {t.tier === 'A' ? <WifiOff size={10} /> : <Plug size={10} />}
                  {t.tier === 'A' ? 'Offline' : 'Connected'}
                </Badge>
                <Badge>{t.category}</Badge>
                <span className="ml-auto font-mono text-[11px] text-faint">{t.id}</span>
              </div>
              <div className="text-[14px] font-semibold">{t.name}</div>
              <div className="mt-1 line-clamp-3 flex-1 text-xs leading-relaxed text-muted">{t.description}</div>
              <div className="mt-3 flex items-center gap-3 text-[11px] text-faint">
                <span className="flex items-center gap-1">
                  <Clock size={11} /> {t.setupMinutes ? `${t.setupMinutes} min setup` : 'no setup'}
                </span>
                <span className="capitalize">{t.difficulty}</span>
                <span className="ml-auto">{t.triggerType}</span>
              </div>
            </Card>
          ))}
          {tier !== 'A'
            ? list.data?.planned.map((p) => (
                <Card key={p.id} className="flex flex-col border-dashed p-4 opacity-70" data-testid={`template-planned-${p.id}`}>
                  <div className="mb-2 flex items-center gap-1.5">
                    <Badge tone="warn">Planned</Badge>
                    <span className="ml-auto font-mono text-[11px] text-faint">{p.id}</span>
                  </div>
                  <div className="text-[14px] font-semibold">{p.name}</div>
                  <div className="mt-1 text-xs leading-relaxed text-muted">{p.description}</div>
                  <div className="mt-2 text-[11px] leading-relaxed text-faint">{p.reason}</div>
                </Card>
              ))
            : null}
        </div>
      </div>
      {open ? <TemplateDialog summary={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

function TemplateDialog({ summary, onClose }: { summary: TemplateSummary; onClose: () => void }) {
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ['template', summary.id], queryFn: () => api.template(summary.id) });
  const info = useQuery({ queryKey: ['info'], queryFn: api.info });
  const [demo, setDemo] = useState(summary.tier === 'A' || !!summary.demoOverrides);
  const [values, setValues] = useState<Record<string, string | number | boolean>>({});
  const [busy, setBusy] = useState(false);
  const t = detail.data;
  const isB = summary.tier === 'B';
  const resolveDefault = (v: string | number | boolean) =>
    typeof v === 'string' && info.data ? v.replaceAll('${demoDir}', info.data.demoDir).replaceAll('${fixturesUrl}', info.data.fixturesUrl).replaceAll('${templateDir}', `${info.data.demoDir}/templates/${summary.id}-…`) : v;
  const shownVars = summary.variables.filter((v) => !(demo && isB && summary.demoOverrides && v.name in summary.demoOverrides));

  const use = async () => {
    setBusy(true);
    try {
      const changed = Object.fromEntries(Object.entries(values).filter(([k, v]) => String(v) !== String(summary.variables.find((x) => x.name === k)?.default)));
      const r = await api.instantiate(summary.id, { demo, ...(Object.keys(changed).length ? { variables: changed } : {}) });
      void qc.invalidateQueries({ queryKey: ['workflows'] });
      toast.ok(`Created “${r.workflow.name}”`, demo && isB ? 'Demo mode uses the local fixture server, not the real service.' : 'Press Run to try it.');
      navigate(`/workflows/${r.workflow.id}`);
    } catch (e) {
      toast.error('Could not create workflow', e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      width={720}
      testId="template-dialog"
      title={
        <span className="flex items-center gap-2">
          <span className="font-mono text-xs text-faint">{summary.id}</span> {summary.name}
        </span>
      }
      footer={
        <>
          <span className="mr-auto text-[11px] text-faint">By continuing you grant the permissions listed above to this workflow only.</span>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || (isB && !demo && !t)} onClick={() => void use()} data-testid="template-use">
            {isB ? (demo ? 'Create demo workflow' : 'Create live workflow') : 'Use template'}
          </Button>
        </>
      }
    >
      <p className="text-[13px] leading-relaxed text-muted">{summary.description}</p>

      {isB ? (
        <div className="mt-4 grid grid-cols-2 gap-2">
          <ModeCard active={demo} onClick={() => setDemo(true)} icon={<FlaskConical size={15} />} title="Try demo" disabled={!summary.demoOverrides}>
            Runs against PulseFlow’s local fixture server with sample data. Nothing is sent to {summary.services.join(', ') || 'any service'}.
          </ModeCard>
          <ModeCard active={!demo} onClick={() => setDemo(false)} icon={<Globe size={15} />} title="Run live">
            {summary.liveRequirements ?? 'Requires your own account and credentials.'}
          </ModeCard>
        </div>
      ) : null}

      <div className="mt-5 grid grid-cols-2 gap-5">
        <div>
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted uppercase">
            <ShieldCheck size={13} /> Permissions requested
          </div>
          <ul className="space-y-1.5 text-xs" data-testid="template-permissions">
            {summary.permissions.length === 0 ? <li className="text-faint">None</li> : null}
            {summary.permissions.map((p) => (
              <li key={p} className="flex items-start gap-2">
                <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-warn" />
                <span>{PERMISSION_TEXT[p] ?? p}</span>
              </li>
            ))}
          </ul>
          {summary.requiredCredentials.length && !demo ? (
            <div className="mt-3 rounded-lg border border-warn/30 bg-warn/10 p-2.5 text-xs text-warn">
              Needs: {summary.requiredCredentials.map((c) => c.label).join(', ')}. Add them under Credentials, then select them in the workflow.
            </div>
          ) : null}
          <div className="mt-4 mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">Sample output</div>
          <pre className="max-h-40 overflow-auto rounded-lg border border-line bg-bg p-2.5 font-mono text-[11px] whitespace-pre-wrap text-muted">{summary.sample.output}</pre>
        </div>
        <div>
          <div className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">Settings</div>
          <div className="space-y-3">
            {shownVars.length === 0 ? <div className="text-xs text-faint">Nothing to configure.</div> : null}
            {shownVars.map((v) => {
              const value = values[v.name] ?? resolveDefault(v.default);
              return (
                <div key={v.name}>
                  {v.kind === 'boolean' ? (
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-muted">{v.label}</span>
                      <Switch checked={value === true} onChange={(b) => setValues((s) => ({ ...s, [v.name]: b }))} />
                    </div>
                  ) : (
                    <>
                      <Label hint={v.access ? (v.access === 'readwrite' ? 'read & write' : 'read only') : undefined}>{v.label}</Label>
                      <div className="flex gap-1.5">
                        <Input value={String(value)} onChange={(e) => setValues((s) => ({ ...s, [v.name]: v.kind === 'number' ? Number(e.target.value) : e.target.value }))} className={cx((v.kind === 'folder' || v.kind === 'file') && 'font-mono text-xs')} />
                        {bridge && (v.kind === 'folder' || v.kind === 'file') ? (
                          <Button
                            size="md"
                            onClick={async () => {
                              const p = v.kind === 'folder' ? await bridge!.selectFolder(v.label) : await bridge!.selectFile(v.label);
                              if (p) setValues((s) => ({ ...s, [v.name]: p }));
                            }}
                          >
                            Browse
                          </Button>
                        ) : null}
                      </div>
                    </>
                  )}
                  {v.description ? <div className="mt-1 text-[11px] text-faint">{v.description}</div> : null}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {t?.docs ? (
        <details className="mt-5 rounded-lg border border-line bg-bg/50 p-3 text-xs">
          <summary className="cursor-pointer font-medium">How it works</summary>
          <div className="mt-2 leading-relaxed whitespace-pre-wrap text-muted">{t.docs}</div>
        </details>
      ) : null}
    </Modal>
  );
}

function ModeCard({ active, onClick, icon, title, children, disabled }: { active: boolean; onClick: () => void; icon: React.ReactNode; title: string; children: React.ReactNode; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      data-testid={`mode-${title.toLowerCase().replace(/\s+/g, '-')}`}
      className={cx('rounded-xl border p-3 text-left transition-colors disabled:opacity-40', active ? 'border-accent bg-accent/10' : 'border-line bg-bg/40 hover:border-line-strong')}
    >
      <div className="flex items-center gap-2 text-[13px] font-medium">
        {icon} {title}
      </div>
      <div className="mt-1 text-[11.5px] leading-snug text-muted">{children}</div>
    </button>
  );
}
