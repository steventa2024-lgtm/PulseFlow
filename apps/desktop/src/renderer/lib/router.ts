import { useSyncExternalStore } from 'react';

const current = () => window.location.hash.replace(/^#/, '') || '/';

const subscribe = (fn: () => void) => {
  window.addEventListener('hashchange', fn);
  return () => window.removeEventListener('hashchange', fn);
};

export function useRoute(): string {
  return useSyncExternalStore(subscribe, current);
}

export function navigate(path: string): void {
  if (current() !== path) window.location.hash = path;
}

/** Matches "/workflows/:id" style patterns. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/');
  const s = path.split('?')[0]!.split('/');
  if (p.length !== s.length) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const seg = p[i]!;
    if (seg.startsWith(':')) out[seg.slice(1)] = decodeURIComponent(s[i]!);
    else if (seg !== s[i]) return null;
  }
  return out;
}
