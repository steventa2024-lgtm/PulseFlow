import type { NodeCatalogEntry } from '@pulseflow/contracts';
import { ChevronDown, Lock, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge, cx } from '../components/ui';
import { CATEGORY_COLORS, CATEGORY_LABELS, NodeIcon } from '../lib/icons';

export const DRAG_MIME = 'application/x-pulseflow-node';
const ORDER = ['trigger', 'logic', 'data', 'files', 'network', 'notify', 'ai', 'connector', 'developer'];

export function Library({ catalog, onAdd }: { catalog: NodeCatalogEntry[]; onAdd: (entry: NodeCatalogEntry) => void }) {
  const [q, setQ] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const groups = useMemo(() => {
    const term = q.trim().toLowerCase();
    const list = catalog.filter((e) => !term || `${e.displayName} ${e.description} ${e.type}`.toLowerCase().includes(term));
    const by = new Map<string, NodeCatalogEntry[]>();
    for (const e of list) by.set(e.category, [...(by.get(e.category) ?? []), e]);
    return [...by.entries()].sort((a, b) => ORDER.indexOf(a[0]) - ORDER.indexOf(b[0]));
  }, [catalog, q]);

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-panel" aria-label="Node library">
      <div className="border-b border-line p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-semibold tracking-wide text-muted uppercase">Library</span>
          <span className="text-[11px] text-faint">{catalog.length} nodes</span>
        </div>
        <div className="relative">
          <Search size={14} className="absolute top-2 left-2.5 text-faint" />
          <input
            data-testid="library-search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search nodes…"
            className="h-8 w-full rounded-lg border border-line bg-bg pr-2 pl-8 text-[13px] placeholder:text-faint focus:border-accent focus:outline-none"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {groups.map(([cat, entries]) => (
          <div key={cat} className="mb-1">
            <button type="button" className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1.5 text-[11px] font-semibold tracking-wide text-faint uppercase hover:text-muted" onClick={() => setCollapsed((c) => ({ ...c, [cat]: !c[cat] }))}>
              <ChevronDown size={12} className={cx('transition-transform', collapsed[cat] && !q && '-rotate-90')} />
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: CATEGORY_COLORS[cat] }} />
              {CATEGORY_LABELS[cat] ?? cat}
              <span className="ml-auto font-normal">{entries.length}</span>
            </button>
            {collapsed[cat] && !q
              ? null
              : entries.map((e) => (
                  <div
                    key={e.type}
                    role="button"
                    tabIndex={0}
                    draggable={e.enabled}
                    data-testid={`library-item-${e.type}`}
                    title={e.enabled ? `${e.description}\n\nClick or drag onto the canvas.` : e.disabledReason}
                    onDragStart={(ev) => {
                      ev.dataTransfer.setData(DRAG_MIME, e.type);
                      ev.dataTransfer.effectAllowed = 'move';
                    }}
                    onClick={() => e.enabled && onAdd(e)}
                    onKeyDown={(ev) => ev.key === 'Enter' && e.enabled && onAdd(e)}
                    className={cx('group flex cursor-grab items-start gap-2.5 rounded-lg px-2 py-1.5 hover:bg-hover', !e.enabled && 'cursor-not-allowed opacity-50')}
                  >
                    <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md" style={{ background: `${CATEGORY_COLORS[e.category]}1a`, color: CATEGORY_COLORS[e.category] }}>
                      <NodeIcon name={e.icon} size={13} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 text-[12.5px] text-ink">
                        <span className="truncate">{e.displayName}</span>
                        {!e.enabled ? <Lock size={11} className="shrink-0 text-warn" /> : null}
                        {e.status === 'requires-setup' ? <Badge tone="warn" className="!px-1 !text-[9.5px]">setup</Badge> : e.status === 'beta' ? <Badge tone="violet" className="!px-1 !text-[9.5px]">beta</Badge> : null}
                      </div>
                      <div className="line-clamp-2 text-[11px] leading-snug text-faint">{e.description}</div>
                    </div>
                  </div>
                ))}
          </div>
        ))}
        {groups.length === 0 ? <div className="px-3 py-6 text-center text-xs text-faint">No nodes match “{q}”.</div> : null}
      </div>
    </aside>
  );
}
