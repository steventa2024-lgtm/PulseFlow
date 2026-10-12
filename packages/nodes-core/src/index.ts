import { NodeRegistry, type NodeDefinition } from '@pulseflow/engine';
import { aiNodes } from './ai';
import { dataNodes } from './data';
import { developerNodes } from './developer';
import { fileNodes } from './files';
import { logicNodes } from './logic';
import { networkNodes } from './network';
import { triggerNodes } from './triggers';

export * from './helpers';
export * from './csv';
export * from './feed';
export * from './json-schema';
export { authHeaders, kvListToRecord, throwForStatus } from './network';
export { INLINE_WAIT_LIMIT_MS } from './logic';

export const coreNodes: NodeDefinition[] = [...triggerNodes, ...logicNodes, ...dataNodes, ...fileNodes, ...networkNodes, ...developerNodes, ...aiNodes];

export function createCoreRegistry(extra: NodeDefinition[] = []): NodeRegistry {
  return new NodeRegistry().registerAll([...coreNodes, ...extra]);
}
