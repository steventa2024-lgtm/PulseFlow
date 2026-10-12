import { builtinNodes } from "./catalog";
import type { NodeDefinition } from "./types";

export class NodeRegistry {
  private readonly nodes = new Map<string, NodeDefinition>();

  register(definition: NodeDefinition): void {
    this.nodes.set(definition.manifest.id, definition);
  }

  get(id: string): NodeDefinition | undefined {
    return this.nodes.get(id);
  }

  list() {
    return [...this.nodes.values()].map((definition) => definition.manifest);
  }
}

export function createRegistry(): NodeRegistry {
  const registry = new NodeRegistry();
  for (const definition of builtinNodes()) registry.register(definition);
  return registry;
}

export type { NodeContext, NodeDefinition } from "./types";
export { builtinNodes } from "./catalog";
