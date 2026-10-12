export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const diff = now - Date.parse(iso);
  const abs = Math.abs(diff);
  const fmt = (n: number, unit: string) => `${Math.round(n)} ${unit}${Math.round(n) === 1 ? '' : 's'}`;
  const out = abs < 45_000 ? 'just now' : abs < 3_600_000 ? fmt(abs / 60_000, 'min') : abs < 86_400_000 ? fmt(abs / 3_600_000, 'hour') : fmt(abs / 86_400_000, 'day');
  if (out === 'just now') return out;
  return diff >= 0 ? `${out} ago` : `in ${out}`;
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function executionDuration(e: { startedAt: string | null; finishedAt: string | null }): number | null {
  if (!e.startedAt) return null;
  return (e.finishedAt ? Date.parse(e.finishedAt) : Date.now()) - Date.parse(e.startedAt);
}

export function clockTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export const STATE_STYLES: Record<string, { label: string; dot: string; text: string; bg: string }> = {
  queued: { label: 'Queued', dot: 'bg-faint', text: 'text-muted', bg: 'bg-raised' },
  running: { label: 'Running', dot: 'bg-accent', text: 'text-accent', bg: 'bg-accent/10' },
  waiting: { label: 'Waiting', dot: 'bg-violet', text: 'text-violet', bg: 'bg-violet/10' },
  succeeded: { label: 'Succeeded', dot: 'bg-ok', text: 'text-ok', bg: 'bg-ok/10' },
  failed: { label: 'Failed', dot: 'bg-bad', text: 'text-bad', bg: 'bg-bad/10' },
  cancelled: { label: 'Cancelled', dot: 'bg-faint', text: 'text-muted', bg: 'bg-raised' },
  timed_out: { label: 'Timed out', dot: 'bg-warn', text: 'text-warn', bg: 'bg-warn/10' },
  retrying: { label: 'Retrying', dot: 'bg-warn', text: 'text-warn', bg: 'bg-warn/10' },
  skipped: { label: 'Skipped', dot: 'bg-line-strong', text: 'text-faint', bg: 'bg-raised' },
  pending: { label: 'Pending', dot: 'bg-line-strong', text: 'text-faint', bg: 'bg-raised' },
};

export const stateStyle = (s: string) => STATE_STYLES[s] ?? STATE_STYLES.queued!;
