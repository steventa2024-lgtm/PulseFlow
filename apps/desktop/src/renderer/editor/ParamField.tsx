import type { CredentialMeta, ParamDef } from '@pulseflow/contracts';
import { FolderOpen, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { bridge } from '../lib/api';
import { Badge, Button, IconButton, Input, Label, Select, Switch, TextArea, cx } from '../components/ui';

export const OPERATORS = [
  ['equals', 'equals'],
  ['notEquals', 'does not equal'],
  ['contains', 'contains'],
  ['notContains', 'does not contain'],
  ['startsWith', 'starts with'],
  ['endsWith', 'ends with'],
  ['gt', 'greater than'],
  ['gte', 'greater or equal'],
  ['lt', 'less than'],
  ['lte', 'less or equal'],
  ['isEmpty', 'is empty'],
  ['isNotEmpty', 'is not empty'],
  ['isTrue', 'is true'],
  ['isFalse', 'is false'],
  ['regex', 'matches regex'],
] as const;
const UNARY = new Set(['isEmpty', 'isNotEmpty', 'isTrue', 'isFalse']);

const isExpr = (v: unknown) => typeof v === 'string' && v.includes('{{');

export function isParamVisible(p: ParamDef, params: Record<string, unknown>): boolean {
  if (!p.showIf) return true;
  const v = params[p.showIf.param];
  return p.showIf.equals.some((x) => x === v);
}

interface Props {
  def: ParamDef;
  value: unknown;
  onChange: (v: unknown) => void;
  credentials: CredentialMeta[];
  issue?: string | undefined;
}

export function ParamField({ def, value, onChange, credentials, issue }: Props) {
  const id = `param-${def.name}`;
  const exprBadge = !def.noExpression && isExpr(value) ? <Badge tone="cyan">fx</Badge> : null;
  const hint = (
    <span className="flex items-center gap-1">
      {exprBadge}
      {def.required ? <span className="text-faint">required</span> : null}
    </span>
  );
  return (
    <div data-testid={id}>
      {def.type === 'boolean' ? (
        <div className="flex items-center justify-between gap-3 py-0.5">
          <label htmlFor={id} className="text-xs font-medium text-muted">
            {def.label}
          </label>
          <Switch checked={value === true} onChange={onChange} label={def.label} />
        </div>
      ) : (
        <Label htmlFor={id} hint={hint}>
          {def.label}
        </Label>
      )}
      <FieldControl id={id} def={def} value={value} onChange={onChange} credentials={credentials} />
      {issue ? <div className="mt-1 text-[11px] text-bad">{issue}</div> : null}
      {def.description ? <div className="mt-1 text-[11px] leading-snug text-faint">{def.description}</div> : null}
    </div>
  );
}

function FieldControl({ id, def, value, onChange, credentials }: Props & { id: string }) {
  switch (def.type) {
    case 'boolean':
      return null;
    case 'select':
      return (
        <Select id={id} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
          {(def.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      );
    case 'number':
      return (
        <Input
          id={id}
          inputMode="decimal"
          value={value === undefined || value === null ? '' : String(value)}
          placeholder={def.placeholder}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw.trim() === '') return onChange(undefined);
            const n = Number(raw);
            onChange(!Number.isNaN(n) && !raw.includes('{{') ? n : def.noExpression ? value : raw);
          }}
        />
      );
    case 'text':
      return <TextArea id={id} value={String(value ?? '')} placeholder={def.placeholder} onChange={(e) => onChange(e.target.value)} />;
    case 'code':
      return <TextArea id={id} className="min-h-36" value={String(value ?? '')} placeholder={def.placeholder} onChange={(e) => onChange(e.target.value)} />;
    case 'json':
      return <JsonField id={id} value={value} onChange={onChange} />;
    case 'stringList':
      return (
        <TextArea
          id={id}
          value={Array.isArray(value) ? value.join('\n') : String(value ?? '')}
          placeholder="One per line"
          onChange={(e) => onChange(isExpr(e.target.value) && !e.target.value.includes('\n') ? e.target.value : e.target.value.split('\n'))}
        />
      );
    case 'path':
      return (
        <div className="flex gap-1.5">
          <Input id={id} value={String(value ?? '')} placeholder={def.placeholder ?? 'C:\\Users\\you\\Documents\\folder'} onChange={(e) => onChange(e.target.value)} className="font-mono text-xs" />
          {bridge ? (
            <IconButton
              label="Browse"
              className="border border-line"
              onClick={async () => {
                const picked = /folder|dir/i.test(def.name) ? await bridge!.selectFolder(def.label) : await bridge!.selectFile(def.label);
                if (picked) onChange(picked);
              }}
            >
              <FolderOpen size={14} />
            </IconButton>
          ) : null}
        </div>
      );
    case 'credential': {
      const options = credentials.filter((c) => !def.credentialType || c.type === def.credentialType);
      const v = String(value ?? '');
      return (
        <div className="space-y-1.5">
          <Select id={id} value={isExpr(v) ? '__expr' : v} onChange={(e) => onChange(e.target.value === '__expr' ? '{{ $vars.credential }}' : e.target.value)}>
            <option value="">— Select a credential —</option>
            {options.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
            <option value="__expr">Use an expression…</option>
          </Select>
          {isExpr(v) ? <Input value={v} onChange={(e) => onChange(e.target.value)} className="font-mono text-xs" /> : null}
          {options.length === 0 ? (
            <div className="text-[11px] text-faint">
              No {def.credentialType ?? ''} credentials yet. Add one under <a href="#/credentials" className="text-accent hover:underline">Credentials</a>.
            </div>
          ) : null}
        </div>
      );
    }
    case 'keyvalue':
      return <KeyValueField value={value} onChange={onChange} />;
    case 'conditions':
      return <ConditionsField value={value} onChange={onChange} />;
    case 'rules':
      return <ConditionsField value={value} onChange={onChange} withLabel />;
    default:
      return (
        <Input
          id={id}
          value={typeof value === 'string' || typeof value === 'number' ? String(value) : value === undefined || value === null ? '' : JSON.stringify(value)}
          placeholder={def.placeholder}
          type={def.sensitive ? 'password' : 'text'}
          onChange={(e) => onChange(e.target.value)}
          className={cx(isExpr(value) && 'font-mono text-xs text-cyan')}
        />
      );
  }
}

function JsonField({ id, value, onChange }: { id: string; value: unknown; onChange: (v: unknown) => void }) {
  const serialize = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v ?? null, null, 2));
  const [text, setText] = useState(serialize(value));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setText((t) => {
      try {
        return JSON.stringify(JSON.parse(t)) === JSON.stringify(value) ? t : serialize(value);
      } catch {
        return t;
      }
    });
  }, [value]);
  return (
    <>
      <TextArea
        id={id}
        className={cx('min-h-28', error && '!border-bad')}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          if (isExpr(e.target.value) && !e.target.value.trim().startsWith('{"') && !e.target.value.trim().startsWith('[')) {
            setError(null);
            return onChange(e.target.value);
          }
          try {
            onChange(JSON.parse(e.target.value));
            setError(null);
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      />
      {error ? <div className="mt-1 text-[11px] text-bad">Invalid JSON: {error}</div> : null}
    </>
  );
}

function KeyValueField({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const rows = Array.isArray(value) ? (value as { name: string; value: string }[]) : [];
  const update = (i: number, patch: Partial<{ name: string; value: string }>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-1.5">
      {rows.map((r, i) => (
        <div key={i} className="flex gap-1.5">
          <Input value={r.name ?? ''} placeholder="Name" onChange={(e) => update(i, { name: e.target.value })} className="w-2/5" />
          <Input value={String(r.value ?? '')} placeholder="Value" onChange={(e) => update(i, { value: e.target.value })} />
          <IconButton label="Remove row" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
            <Trash2 size={13} />
          </IconButton>
        </div>
      ))}
      <Button size="sm" variant="ghost" icon={<Plus size={13} />} onClick={() => onChange([...rows, { name: '', value: '' }])}>
        Add row
      </Button>
    </div>
  );
}

type Cond = { label?: string; left: unknown; operator: string; right?: unknown };

function ConditionsField({ value, onChange, withLabel }: { value: unknown; onChange: (v: unknown) => void; withLabel?: boolean }) {
  const rows = Array.isArray(value) ? (value as Cond[]) : [];
  const update = (i: number, patch: Partial<Cond>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const str = (v: unknown) => (v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v));
  return (
    <div className="space-y-2">
      {rows.map((r, i) => (
        <div key={i} className="space-y-1.5 rounded-lg border border-line bg-bg/60 p-2">
          <div className="flex items-center gap-1.5">
            {withLabel ? <Input value={r.label ?? ''} placeholder={`Case ${i + 1}`} onChange={(e) => update(i, { label: e.target.value })} className="h-7 text-xs" /> : <span className="text-[11px] text-faint">#{i + 1}</span>}
            <div className="flex-1" />
            <IconButton label="Remove condition" className="h-6 w-6" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
              <Trash2 size={12} />
            </IconButton>
          </div>
          <Input value={str(r.left)} placeholder="{{ $json.field }}" onChange={(e) => update(i, { left: e.target.value })} className="h-7 font-mono text-xs" />
          <Select value={r.operator} onChange={(e) => update(i, { operator: e.target.value })} className="h-7 text-xs">
            {OPERATORS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
          {UNARY.has(r.operator) ? null : <Input value={str(r.right)} placeholder="Value" onChange={(e) => update(i, { right: e.target.value })} className="h-7 font-mono text-xs" />}
        </div>
      ))}
      <Button size="sm" variant="ghost" icon={<Plus size={13} />} onClick={() => onChange([...rows, { ...(withLabel ? { label: `Case ${rows.length + 1}` } : {}), left: '', operator: 'equals', right: '' }])}>
        {withLabel ? 'Add rule' : 'Add condition'}
      </Button>
    </div>
  );
}
