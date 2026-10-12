import { useQuery, useQueryClient } from '@tanstack/react-query';
import { HardDriveDownload, Info, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { api, bridge, getDesktopInfo, type AppSettings } from '../lib/api';
import { Badge, Button, Card, Input, Label, Switch, toast } from '../components/ui';

export function SettingsPage() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const info = useQuery({ queryKey: ['info'], queryFn: api.info });
  const [envText, setEnvText] = useState<string | null>(null);
  const desktop = getDesktopInfo();
  const update = async (patch: Partial<AppSettings>) => {
    try {
      const next = await api.updateSettings(patch);
      qc.setQueryData(['settings'], next);
      if (patch.keepRunningInTray !== undefined) await bridge?.setKeepInTray(patch.keepRunningInTray);
      if (patch.advancedNodes !== undefined) void qc.invalidateQueries({ queryKey: ['nodes'] });
      toast.ok('Settings saved');
    } catch (e) {
      toast.error('Could not save settings', e);
    }
  };
  const s = settings.data;
  return (
    <div className="h-full overflow-y-auto" data-testid="settings-page">
      <div className="mx-auto max-w-3xl space-y-5 px-8 py-7">
        <h1 className="text-xl font-semibold">Settings</h1>
        {s ? (
          <>
            <Card className="divide-y divide-line">
              <Row title="Keep running in the tray" desc="Closing the window keeps active workflows running. Quit from the tray icon to stop them.">
                <Switch checked={s.keepRunningInTray} onChange={(v) => void update({ keepRunningInTray: v })} label="Keep running in tray" />
              </Row>
              <Row title="Run history retention" desc="Finished runs older than this are deleted on startup.">
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={1}
                    max={3650}
                    defaultValue={s.retentionDays}
                    className="w-20"
                    onBlur={(e) => Number(e.target.value) !== s.retentionDays && void update({ retentionDays: Math.max(1, Number(e.target.value) || 30) })}
                  />
                  <span className="text-xs text-muted">days</span>
                </div>
              </Row>
              <Row
                title="Environment variables available to expressions"
                desc="Only variables listed here can be read with {{ $env.NAME }}. Everything else is hidden."
              >
                <Input
                  className="w-64 font-mono text-xs"
                  placeholder="API_BASE, MY_FOLDER"
                  value={envText ?? s.envAllowList.join(', ')}
                  onChange={(e) => setEnvText(e.target.value)}
                  onBlur={() => {
                    if (envText === null) return;
                    void update({ envAllowList: envText.split(/[\s,]+/).filter(Boolean) });
                    setEnvText(null);
                  }}
                />
              </Row>
            </Card>

            <Card className="border-bad/30">
              <div className="flex items-start gap-3 p-4">
                <ShieldAlert size={18} className="mt-0.5 shrink-0 text-bad" />
                <div className="flex-1">
                  <div className="flex items-center justify-between gap-4">
                    <div className="text-[13px] font-medium">Advanced nodes (Execute Command, Code)</div>
                    <Switch checked={s.advancedNodes} onChange={(v) => void update({ advancedNodes: v })} label="Advanced nodes" />
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-muted">
                    Off by default. These nodes run programs or scripts with your Windows account’s full rights. Worker threads and Node’s <code>vm</code> are{' '}
                    <b>not</b> a security sandbox, so only enable this for workflows you wrote or fully trust. Each workflow must also be granted “Advanced
                    nodes” in its permission review.
                  </p>
                </div>
              </div>
            </Card>
          </>
        ) : null}

        <Card className="p-4">
          <div className="mb-3 flex items-center gap-2 text-[13px] font-medium">
            <HardDriveDownload size={15} /> Backup
          </div>
          <p className="mb-3 text-xs text-muted">
            Writes a consistent copy of the database (workflows, versions, run history and encrypted credentials). Restoring credentials needs this computer’s
            key.
          </p>
          <Button
            onClick={async () => {
              try {
                const r = await api.backup();
                toast.ok('Backup written', r.file);
                await bridge?.showItemInFolder(r.file);
              } catch (e) {
                toast.error('Backup failed', e);
              }
            }}
          >
            Create backup now
          </Button>
        </Card>

        <Card className="p-4" data-testid="about">
          <div className="mb-3 flex items-center gap-2 text-[13px] font-medium">
            <Info size={15} /> About
          </div>
          {info.data ? (
            <dl className="grid grid-cols-[180px_1fr] gap-y-1.5 text-xs">
              <dt className="text-faint">Version</dt>
              <dd>
                PulseFlow {info.data.version} · engine {info.data.engineVersion}
              </dd>
              <dt className="text-faint">Mode</dt>
              <dd>{info.data.mode === 'local' ? 'Local (single user, loopback only)' : 'Server (accounts & roles)'}</dd>
              <dt className="text-faint">Data folder</dt>
              <dd className="font-mono break-all">{info.data.dataDir}</dd>
              <dt className="text-faint">Demo folder</dt>
              <dd className="font-mono break-all">{info.data.demoDir}</dd>
              <dt className="text-faint">Demo fixture server</dt>
              <dd>{info.data.fixtures ? <span className="font-mono">{info.data.fixturesUrl}</span> : 'disabled'}</dd>
              <dt className="text-faint">Telemetry</dt>
              <dd>
                <Badge tone="ok">None</Badge> PulseFlow sends no usage data anywhere.
              </dd>
              {desktop ? (
                <>
                  <dt className="text-faint">Runtime</dt>
                  <dd>
                    Electron {desktop.versions.electron} · Chromium {desktop.versions.chrome} · Node {desktop.versions.node}
                  </dd>
                </>
              ) : null}
              <dt className="text-faint">License</dt>
              <dd>Apache-2.0 · free and open source, no accounts, no paid tiers</dd>
            </dl>
          ) : null}
        </Card>
      </div>
    </div>
  );
}

function Row({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 p-4">
      <div>
        <Label>{title}</Label>
        <div className="-mt-0.5 text-xs text-faint">{desc}</div>
      </div>
      {children}
    </div>
  );
}
