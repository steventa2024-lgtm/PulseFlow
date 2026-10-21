import type { WorkflowGraph, WorkflowSettings } from '@pulseflow/contracts';

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}

export interface VersionSnapshot {
  graph: WorkflowGraph;
  settings: WorkflowSettings;
}
export interface VersionChange {
  kind: 'Added' | 'Removed' | 'Changed';
  area: 'Node' | 'Connection' | 'Setting';
  name: string;
  fields?: string[];
}

/** A field-level comparison without rendering credential references, secret values or payloads. */
export function compareVersions(before: VersionSnapshot, after: VersionSnapshot): VersionChange[] {
  const changes: VersionChange[] = [];
  for (const [area, left, right] of [
    ['Node', before.graph.nodes, after.graph.nodes],
    ['Connection', before.graph.edges, after.graph.edges],
  ] as const) {
    const previous = new Map<string, { id: string }>(left.map((item) => [item.id, item]));
    const next = new Map<string, { id: string }>(right.map((item) => [item.id, item]));
    const label = (item: { id: string }) => ('name' in item ? String(item.name) : item.id);
    for (const item of left) if (!next.has(item.id)) changes.push({ kind: 'Removed', area, name: label(item) });
    for (const item of right) {
      const old = previous.get(item.id);
      if (!old) changes.push({ kind: 'Added', area, name: label(item) });
      else if (stable(old) !== stable(item)) {
        const a = old as unknown as Record<string, unknown>;
        const b = item as unknown as Record<string, unknown>;
        changes.push({
          kind: 'Changed',
          area,
          name: label(item),
          fields: [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => stable(a[k]) !== stable(b[k])),
        });
      }
    }
  }
  for (const key of [...new Set([...Object.keys(before.settings), ...Object.keys(after.settings)])] as (keyof WorkflowSettings)[]) {
    // Permission grants are maintained independently of immutable published execution settings.
    if (key !== 'permissions' && stable(before.settings[key]) !== stable(after.settings[key])) changes.push({ kind: 'Changed', area: 'Setting', name: key });
  }
  return changes;
}
