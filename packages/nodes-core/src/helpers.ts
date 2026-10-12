import type { Item, NodeManifest, ParamDef } from '@pulseflow/contracts';
import { NodeError, type NodeDefinition, type NodeExecutionContext, type NodeOutput } from '@pulseflow/engine';

export const MAIN = [{ name: 'main' }];

type ManifestInput = Omit<NodeManifest, 'version' | 'inputs' | 'outputs' | 'permissions' | 'risk' | 'status'> &
  Partial<Pick<NodeManifest, 'version' | 'inputs' | 'outputs' | 'permissions' | 'risk' | 'status'>>;

export function defineNode(manifest: ManifestInput, execute: (ctx: NodeExecutionContext) => Promise<NodeOutput>, extra: Partial<NodeDefinition> = {}): NodeDefinition {
  return {
    manifest: {
      version: 1,
      inputs: manifest.trigger ? [] : MAIN,
      outputs: MAIN,
      permissions: [],
      risk: 'normal',
      status: 'stable',
      ...manifest,
    },
    execute,
    ...extra,
  };
}

export function param(def: ParamDef): ParamDef {
  return def;
}

/** Reads a dotted path ("a.b.0.c") from an object without touching prototypes. */
export function getPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (part === '__proto__' || part === 'constructor' || part === 'prototype') return undefined;
    if (Array.isArray(cur)) {
      cur = cur[Number(part)];
    } else if (typeof cur === 'object') {
      cur = Object.prototype.hasOwnProperty.call(cur, part) ? (cur as Record<string, unknown>)[part] : undefined;
    } else {
      return undefined;
    }
  }
  return cur;
}

/** Sets a dotted path, creating intermediate objects. Rejects prototype-polluting keys. */
export function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.').filter(Boolean);
  if (parts.length === 0) throw new NodeError('INVALID_FIELD', 'Field name is empty');
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part === '__proto__' || part === 'constructor' || part === 'prototype') {
      throw new NodeError('INVALID_FIELD', `Field name "${path}" is not allowed`);
    }
    if (i === parts.length - 1) {
      cur[part] = value;
    } else {
      const next = cur[part];
      if (!next || typeof next !== 'object' || Array.isArray(next)) cur[part] = {};
      cur = cur[part] as Record<string, unknown>;
    }
  }
}

export function cloneJson<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

export function itemsOrEmpty(items: Item[]): Item[] {
  return items.length ? items : [{ json: {} }];
}

export function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new NodeError('PARAM_REQUIRED', `${label} is required`);
  return value;
}

export function toNumber(value: unknown, label: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) throw new NodeError('PARAM_TYPE', `${label} must be a number (got ${JSON.stringify(value)})`);
  return n;
}

export interface Condition {
  left: unknown;
  operator: string;
  right?: unknown;
}

export const CONDITION_OPERATORS = [
  { label: 'equals', value: 'equals' },
  { label: 'does not equal', value: 'notEquals' },
  { label: 'contains', value: 'contains' },
  { label: 'does not contain', value: 'notContains' },
  { label: 'starts with', value: 'startsWith' },
  { label: 'ends with', value: 'endsWith' },
  { label: 'greater than', value: 'gt' },
  { label: 'greater or equal', value: 'gte' },
  { label: 'less than', value: 'lt' },
  { label: 'less or equal', value: 'lte' },
  { label: 'is empty', value: 'isEmpty' },
  { label: 'is not empty', value: 'isNotEmpty' },
  { label: 'is true', value: 'isTrue' },
  { label: 'is false', value: 'isFalse' },
  { label: 'matches regex', value: 'regex' },
];

const isEmpty = (v: unknown) =>
  v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && Object.keys(v as object).length === 0);

const num = (v: unknown) => (typeof v === 'number' ? v : Number(v));

function cmp(a: unknown, b: unknown): number {
  const na = num(a);
  const nb = num(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb) && a !== '' && b !== '') return na - nb;
  const da = Date.parse(String(a));
  const db = Date.parse(String(b));
  if (!Number.isNaN(da) && !Number.isNaN(db)) return da - db;
  return String(a).localeCompare(String(b));
}

export function evaluateCondition(c: Condition): boolean {
  const { left, right } = c;
  switch (c.operator) {
    case 'equals':
      return left === right || String(left ?? '') === String(right ?? '');
    case 'notEquals':
      return !(left === right || String(left ?? '') === String(right ?? ''));
    case 'contains':
      return Array.isArray(left) ? left.some((x) => String(x) === String(right)) : String(left ?? '').includes(String(right ?? ''));
    case 'notContains':
      return Array.isArray(left) ? !left.some((x) => String(x) === String(right)) : !String(left ?? '').includes(String(right ?? ''));
    case 'startsWith':
      return String(left ?? '').startsWith(String(right ?? ''));
    case 'endsWith':
      return String(left ?? '').endsWith(String(right ?? ''));
    case 'gt':
      return cmp(left, right) > 0;
    case 'gte':
      return cmp(left, right) >= 0;
    case 'lt':
      return cmp(left, right) < 0;
    case 'lte':
      return cmp(left, right) <= 0;
    case 'isEmpty':
      return isEmpty(left);
    case 'isNotEmpty':
      return !isEmpty(left);
    case 'isTrue':
      return left === true || left === 'true' || left === 1;
    case 'isFalse':
      return left === false || left === 'false' || left === 0 || left === null || left === undefined || left === '';
    case 'regex': {
      const pattern = String(right ?? '');
      if (pattern.length > 500) throw new NodeError('INVALID_REGEX', 'Regex too long');
      return new RegExp(pattern).test(String(left ?? ''));
    }
    default:
      throw new NodeError('INVALID_OPERATOR', `Unknown operator "${c.operator}"`);
  }
}

export function evaluateConditions(conditions: unknown, combine: unknown): boolean {
  const list = Array.isArray(conditions) ? (conditions as Condition[]) : [];
  if (list.length === 0) return true;
  return combine === 'or' ? list.some(evaluateCondition) : list.every(evaluateCondition);
}

export const conditionsParam = (name = 'conditions', label = 'Conditions'): ParamDef => ({
  name,
  label,
  type: 'conditions',
  required: true,
  default: [{ left: '', operator: 'equals', right: '' }],
  description: 'Each row compares a value (usually an expression like {{ $json.status }}) to another.',
});

export const combineParam: ParamDef = {
  name: 'combine',
  label: 'Combine',
  type: 'select',
  default: 'and',
  options: [
    { label: 'All conditions (AND)', value: 'and' },
    { label: 'Any condition (OR)', value: 'or' },
  ],
};
