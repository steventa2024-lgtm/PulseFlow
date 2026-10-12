import type { CredentialMeta, CredentialTypeDef } from '@pulseflow/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Lock, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api, bridge, getDesktopInfo } from '../lib/api';
import { relativeTime } from '../lib/format';
import { Badge, Button, Card, Empty, IconButton, Input, Label, Modal, Select, toast } from '../components/ui';

export function CredentialsPage() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['credentials'], queryFn: api.credentials });
  const types = useQuery({ queryKey: ['credential-types'], queryFn: api.credentialTypes });
  const [editing, setEditing] = useState<{ type: CredentialTypeDef; existing?: CredentialMeta } | null>(null);
  const [newType, setNewType] = useState('');
  const keyProtection = getDesktopInfo()?.keyProtection;

  return (
    <div className="h-full overflow-y-auto" data-testid="credentials-page">
      <div className="mx-auto max-w-4xl px-8 py-7">
        <h1 className="text-xl font-semibold">Credentials</h1>
        <p className="mt-1 mb-5 text-[13px] text-muted">
          Secrets are encrypted at rest (AES-256-GCM) and are write-only: PulseFlow never shows them again, never includes them in exports, and redacts them from logs and run data.
          {keyProtection ? (
            <span className="ml-1">
              Encryption key protected by: <b className="text-ink">{keyProtection === 'os-keychain' ? 'the OS keychain (Windows DPAPI / macOS Keychain / libsecret)' : 'a local key file (no OS keychain available)'}</b>.
            </span>
          ) : null}
        </p>
        <div className="mb-4 flex gap-2">
          <Select value={newType} onChange={(e) => setNewType(e.target.value)} className="w-72" data-testid="credential-type">
            <option value="">Choose a credential type…</option>
            {(types.data ?? []).map((t) => (
              <option key={t.type} value={t.type}>
                {t.displayName}
              </option>
            ))}
          </Select>
          <Button
            variant="primary"
            icon={<Plus size={14} />}
            disabled={!newType}
            onClick={() => {
              const t = types.data?.find((x) => x.type === newType);
              if (t) setEditing({ type: t });
            }}
          >
            Add credential
          </Button>
        </div>
        <Card>
          {list.data?.length ? (
            list.data.map((c) => {
              const t = types.data?.find((x) => x.type === c.type);
              return (
                <div key={c.id} className="flex items-center gap-3 border-b border-line/60 px-4 py-3 last:border-0">
                  <div className="rounded-lg border border-line bg-raised p-2 text-muted">
                    <KeyRound size={15} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium">{c.name}</div>
                    <div className="text-[11px] text-faint">
                      {t?.displayName ?? c.type} · fields: {c.fields.join(', ') || '—'} · updated {relativeTime(c.updatedAt)} · <span className="font-mono">{c.id}</span>
                    </div>
                  </div>
                  <Badge>
                    <Lock size={10} /> encrypted
                  </Badge>
                  {t ? (
                    <Button size="sm" onClick={() => setEditing({ type: t, existing: c })}>
                      Replace secrets
                    </Button>
                  ) : null}
                  <IconButton
                    label={`Delete ${c.name}`}
                    onClick={async () => {
                      if (!window.confirm(`Delete credential “${c.name}”? Workflows using it will fail until you pick another.`)) return;
                      await api.deleteCredential(c.id);
                      void qc.invalidateQueries({ queryKey: ['credentials'] });
                    }}
                  >
                    <Trash2 size={14} />
                  </IconButton>
                </div>
              );
            })
          ) : (
            <Empty icon={<KeyRound size={18} />} title="No credentials yet">
              Offline templates need none. Connected templates (GitHub, Discord, Telegram, Google Sheets, SMTP) ask for one when you run them live.
            </Empty>
          )}
        </Card>
        {types.data?.some((t) => t.docsUrl) ? (
          <div className="mt-6 text-xs text-faint">
            Provider setup guides:{' '}
            {types.data
              .filter((t) => t.docsUrl)
              .map((t, i) => (
                <span key={t.type}>
                  {i ? ' · ' : ''}
                  <a
                    href={t.docsUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-accent hover:underline"
                    onClick={(e) => {
                      if (bridge) {
                        e.preventDefault();
                        void bridge.openExternal(t.docsUrl!);
                      }
                    }}
                  >
                    {t.displayName}
                  </a>
                </span>
              ))}
          </div>
        ) : null}
      </div>
      {editing ? <CredentialDialog type={editing.type} existing={editing.existing} onClose={() => setEditing(null)} onSaved={() => void qc.invalidateQueries({ queryKey: ['credentials'] })} /> : null}
    </div>
  );
}

function CredentialDialog({ type, existing, onClose, onSaved }: { type: CredentialTypeDef; existing?: CredentialMeta | undefined; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(existing?.name ?? type.displayName);
  const [data, setData] = useState<Record<string, string>>({});
  const save = async () => {
    try {
      const filled = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== ''));
      if (existing) await api.updateCredential(existing.id, { name, ...(Object.keys(filled).length ? { data: filled } : {}) });
      else await api.createCredential({ name, type: type.type, data: filled });
      toast.ok(existing ? 'Credential updated' : 'Credential saved');
      onSaved();
      onClose();
    } catch (e) {
      toast.error('Could not save credential', e);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={existing ? `Update ${existing.name}` : `New ${type.displayName} credential`}
      testId="credential-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} data-testid="credential-save">
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <Label>Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        {type.fields.map((f) => (
          <div key={f.name}>
            <Label hint={f.secret ? 'secret · write-only' : f.required ? 'required' : undefined}>{f.label}</Label>
            <Input
              type={f.secret ? 'password' : 'text'}
              autoComplete="off"
              value={data[f.name] ?? ''}
              placeholder={existing ? (f.secret ? '•••••••• (unchanged)' : 'unchanged') : f.placeholder}
              onChange={(e) => setData((d) => ({ ...d, [f.name]: e.target.value }))}
              data-testid={`credential-field-${f.name}`}
            />
          </div>
        ))}
      </div>
    </Modal>
  );
}
