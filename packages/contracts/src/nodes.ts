export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/** The unit of data flowing along edges. Nodes receive and emit arrays of items. */
export interface Item {
  json: Record<string, unknown>;
}

export type NodeCategory = 'trigger' | 'logic' | 'data' | 'files' | 'network' | 'developer' | 'ai' | 'notify' | 'connector';

export type NodePermission = 'fs.read' | 'fs.write' | 'network' | 'notify' | 'email' | 'kv' | 'subworkflow' | 'advanced';

export type ParamType =
  'string' | 'text' | 'number' | 'boolean' | 'select' | 'json' | 'keyvalue' | 'path' | 'stringList' | 'credential' | 'conditions' | 'rules' | 'code';

export interface ParamOption {
  label: string;
  value: string;
}

export interface ParamDef {
  name: string;
  label: string;
  type: ParamType;
  required?: boolean;
  default?: unknown;
  description?: string;
  placeholder?: string;
  options?: ParamOption[];
  /** If true the value is used literally and `{{ }}` expressions are not evaluated. */
  noExpression?: boolean;
  /** Only show/validate the parameter when another parameter has one of these values. */
  showIf?: { param: string; equals: unknown[] };
  credentialType?: string;
  min?: number;
  max?: number;
  /** Mark secrets so the UI masks them and logs redact them. */
  sensitive?: boolean;
}

export interface PortDef {
  name: string;
  label?: string;
}

export type TriggerKind = 'manual' | 'schedule' | 'interval' | 'webhook' | 'fileWatch' | 'folderWatch' | 'poll' | 'startup' | 'error' | 'called';

export interface NodeManifest {
  type: string;
  version: number;
  displayName: string;
  description: string;
  category: NodeCategory;
  icon: string;
  inputs: PortDef[];
  outputs: PortDef[];
  /** Outputs derived from a list parameter (e.g. Switch rules → case0..caseN + fallback). */
  dynamicOutputs?: { param: string; prefix: string; fallback?: string };
  parameters: ParamDef[];
  permissions: NodePermission[];
  risk: 'normal' | 'sensitive' | 'advanced';
  trigger?: TriggerKind;
  /** Plain-language description of external effects shown before activation. */
  sideEffects?: string;
  /** stable = tested executor; requires-setup = needs user credentials/config to run live. */
  status: 'stable' | 'beta' | 'requires-setup';
  /** Whether the node supports the `error` output when onError = route. */
  errorOutput?: boolean;
  docs?: string;
}

export function getNodeOutputs(manifest: NodeManifest, parameters: Record<string, unknown>): PortDef[] {
  const outputs = [...manifest.outputs];
  if (manifest.dynamicOutputs) {
    const list = parameters[manifest.dynamicOutputs.param];
    const count = Array.isArray(list) ? list.length : 0;
    for (let i = 0; i < count; i++) {
      const rule = list && Array.isArray(list) ? (list[i] as { label?: unknown }) : undefined;
      const label = rule && typeof rule.label === 'string' && rule.label ? rule.label : `Case ${i + 1}`;
      outputs.push({ name: `${manifest.dynamicOutputs.prefix}${i}`, label });
    }
    if (manifest.dynamicOutputs.fallback) outputs.push({ name: manifest.dynamicOutputs.fallback, label: 'Fallback' });
  }
  return outputs;
}

export function getNodeOutputsWithError(manifest: NodeManifest, parameters: Record<string, unknown>, onError: string | undefined): PortDef[] {
  const outputs = getNodeOutputs(manifest, parameters);
  if (onError === 'route') outputs.push({ name: 'error', label: 'Error' });
  return outputs;
}
