import { describe, expect, it } from 'vitest';
import { defaultWorkflowSettings, type WorkflowGraph } from '@pulseflow/contracts';
import { compareVersions } from './comparison';

const graph: WorkflowGraph = {
  schemaVersion: 1,
  nodes: [{ id: 'n', name: 'Node', type: 'core.set', typeVersion: 1, position: { x: 0, y: 0 }, parameters: { secret: 'hidden-value', a: 1 } }],
  edges: [],
};
const settings = defaultWorkflowSettings();
describe('version comparison', () => {
  it('ignores object key order, node ordering and independent permission timestamps', () => {
    const after = structuredClone({ graph, settings });
    after.graph.nodes[0]!.parameters = { a: 1, secret: 'hidden-value' };
    after.settings.permissions.confirmedAt = new Date().toISOString();
    expect(compareVersions({ graph, settings }, after)).toEqual([]);
  });
  it('reports added/removed/edited nodes and settings without returning secret values', () => {
    const after = structuredClone({ graph, settings });
    after.graph.nodes[0]!.parameters.a = 2;
    after.graph.nodes.push({ ...after.graph.nodes[0]!, id: 'new', name: 'New' });
    after.settings.timezone = 'Pacific/Honolulu';
    const changes = compareVersions({ graph, settings }, after);
    expect(changes).toEqual([
      { kind: 'Changed', area: 'Node', name: 'Node', fields: ['parameters'] },
      { kind: 'Added', area: 'Node', name: 'New' },
      { kind: 'Changed', area: 'Setting', name: 'timezone' },
    ]);
    expect(JSON.stringify(changes)).not.toContain('hidden-value');
    expect(compareVersions(after, { graph, settings }).some((c) => c.kind === 'Removed')).toBe(true);
  });
});
