import type { NodeManifest } from "@pulseflow/contracts";
import { useMemo, useState } from "react";

const groups = ["trigger", "logic", "data", "files", "network", "action", "developer"] as const;

export function Library({
  manifests,
  onAdd,
}: {
  manifests: NodeManifest[];
  onAdd: (manifest: NodeManifest) => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return manifests.filter((manifest) => {
      if (!needle) return true;
      return `${manifest.title} ${manifest.id} ${manifest.category}`.toLowerCase().includes(needle);
    });
  }, [manifests, query]);

  return (
    <aside className="flex min-h-0 flex-col border-r border-line bg-panel">
      <div className="border-b border-line px-3 py-2 text-xs font-semibold tracking-wide text-muted">LIBRARY</div>
      <label className="px-3 py-2">
        <span className="sr-only">Search nodes</span>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search nodes"
          className="h-8 w-full rounded-xl border border-line bg-canvas px-3 text-sm outline-none focus:border-accent"
        />
      </label>
      <div className="min-h-0 flex-1 overflow-auto px-2 pb-3">
        {groups.map((group) => {
          const items = filtered.filter((manifest) => manifest.category === group);
          if (items.length === 0) return null;
          return (
            <section key={group} className="mt-2">
              <h2 className="px-2 py-1 text-[11px] uppercase tracking-wide text-muted">{group}</h2>
              <ul>
                {items.map((manifest) => (
                  <li key={manifest.id}>
                    <button
                      type="button"
                      draggable
                      onDragStart={(event) => {
                        event.dataTransfer.setData("application/pulseflow-node", manifest.id);
                        event.dataTransfer.effectAllowed = "move";
                      }}
                      onClick={() => onAdd(manifest)}
                      className="w-full rounded-lg px-2 py-1.5 text-left text-sm hover:bg-panel-2"
                      title={manifest.description}
                    >
                      {manifest.title}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </aside>
  );
}
