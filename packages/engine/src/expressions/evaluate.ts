import { ExpressionError, parseExpression, type AstNode } from './parser';
import { callFunction, type FunctionContext } from './functions';

const BLOCKED_PROPS = new Set(['__proto__', 'prototype', 'constructor', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__']);

export interface ExpressionScope {
  /** Root identifiers available to expressions, e.g. $json, $node, $vars. */
  roots: Record<string, unknown>;
  fn: FunctionContext;
}

const cache = new Map<string, AstNode>();

export function compileExpression(src: string): AstNode {
  let ast = cache.get(src);
  if (!ast) {
    ast = parseExpression(src);
    if (cache.size > 5000) cache.clear();
    cache.set(src, ast);
  }
  return ast;
}

function getMember(obj: unknown, prop: unknown, optional: boolean): unknown {
  if (obj === null || obj === undefined) {
    if (optional) return undefined;
    return undefined;
  }
  const key = typeof prop === 'number' ? prop : String(prop);
  if (typeof key === 'string' && BLOCKED_PROPS.has(key)) throw new ExpressionError(`Access to "${key}" is not allowed`);
  if (typeof obj === 'string') {
    if (key === 'length') return obj.length;
    if (typeof key === 'number' || /^\d+$/.test(key)) return obj[Number(key)];
    return undefined;
  }
  if (Array.isArray(obj)) {
    if (key === 'length') return obj.length;
    const idx = typeof key === 'number' ? key : /^-?\d+$/.test(key) ? Number(key) : Number.NaN;
    if (Number.isInteger(idx)) return idx < 0 ? obj[obj.length + idx] : obj[idx];
    return undefined;
  }
  if (typeof obj === 'object') {
    // Own, enumerable data properties only: never walk the prototype chain or invoke getters.
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    if (!desc || !('value' in desc)) return undefined;
    return typeof desc.value === 'function' ? undefined : desc.value;
  }
  return undefined;
}

function looseEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
  if (typeof a === 'number' && typeof b === 'string') return a === Number(b);
  if (typeof a === 'string' && typeof b === 'number') return Number(a) === b;
  if (typeof a === 'boolean' || typeof b === 'boolean') return String(a) === String(b);
  return false;
}

function truthy(v: unknown): boolean {
  return Boolean(v);
}

export function evaluateAst(node: AstNode, scope: ExpressionScope): unknown {
  switch (node.kind) {
    case 'literal':
      return node.value;
    case 'ident': {
      if (!Object.prototype.hasOwnProperty.call(scope.roots, node.name)) {
        throw new ExpressionError(`Unknown variable "${node.name}". Available: ${Object.keys(scope.roots).join(', ')}`);
      }
      return scope.roots[node.name];
    }
    case 'member': {
      const obj = evaluateAst(node.object, scope);
      if ((obj === null || obj === undefined) && node.optional) return undefined;
      const prop = node.computed ? evaluateAst(node.property, scope) : (node.property as { value: unknown }).value;
      return getMember(obj, prop, node.optional);
    }
    case 'call':
      return callFunction(
        node.callee,
        scope.fn,
        node.args.map((a) => evaluateAst(a, scope)),
      );
    case 'unary': {
      const v = evaluateAst(node.arg, scope);
      if (node.op === '!') return !truthy(v);
      if (node.op === '-') return -Number(v);
      return Number(v);
    }
    case 'binary': {
      if (node.op === '&&') {
        const l = evaluateAst(node.left, scope);
        return truthy(l) ? evaluateAst(node.right, scope) : l;
      }
      if (node.op === '||') {
        const l = evaluateAst(node.left, scope);
        return truthy(l) ? l : evaluateAst(node.right, scope);
      }
      if (node.op === '??') {
        const l = evaluateAst(node.left, scope);
        return l === null || l === undefined ? evaluateAst(node.right, scope) : l;
      }
      const l = evaluateAst(node.left, scope);
      const r = evaluateAst(node.right, scope);
      switch (node.op) {
        case '+':
          if (typeof l === 'number' && typeof r === 'number') return l + r;
          return `${l === null || l === undefined ? '' : typeof l === 'object' ? JSON.stringify(l) : String(l)}${
            r === null || r === undefined ? '' : typeof r === 'object' ? JSON.stringify(r) : String(r)
          }`;
        case '-':
          return Number(l) - Number(r);
        case '*':
          return Number(l) * Number(r);
        case '/':
          return Number(l) / Number(r);
        case '%':
          return Number(l) % Number(r);
        case '==':
          return looseEquals(l, r);
        case '!=':
          return !looseEquals(l, r);
        case '===':
          return l === r;
        case '!==':
          return l !== r;
        case '<':
          return (l as number) < (r as number);
        case '>':
          return (l as number) > (r as number);
        case '<=':
          return (l as number) <= (r as number);
        case '>=':
          return (l as number) >= (r as number);
        default:
          throw new ExpressionError(`Unsupported operator ${node.op}`);
      }
    }
    case 'conditional':
      return truthy(evaluateAst(node.test, scope)) ? evaluateAst(node.then, scope) : evaluateAst(node.else, scope);
    case 'array':
      return node.elements.map((e) => evaluateAst(e, scope));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const { key, value } of node.entries) {
        if (BLOCKED_PROPS.has(key)) throw new ExpressionError(`Key "${key}" is not allowed`);
        out[key] = evaluateAst(value, scope);
      }
      return out;
    }
  }
}

export function evaluateExpression(src: string, scope: ExpressionScope): unknown {
  return evaluateAst(compileExpression(src), scope);
}

const TEMPLATE_RE = /\{\{([\s\S]+?)\}\}/g;
const WHOLE_RE = /^\s*\{\{([\s\S]+?)\}\}\s*$/;

export function hasExpression(value: unknown): boolean {
  return typeof value === 'string' && value.includes('{{') && /\{\{[\s\S]+?\}\}/.test(value);
}

/**
 * Resolves `{{ expr }}` placeholders in a string. If the whole string is a single
 * placeholder the raw value (number, object, list...) is returned instead of text.
 */
export function resolveTemplate(value: string, scope: ExpressionScope): unknown {
  const whole = WHOLE_RE.exec(value);
  if (whole && !whole[1]!.includes('{{')) return evaluateExpression(whole[1]!.trim(), scope);
  return value.replace(TEMPLATE_RE, (_m, expr: string) => {
    const v = evaluateExpression(expr.trim(), scope);
    if (v === null || v === undefined) return '';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

/** Deeply resolves expressions within parameter values (strings inside arrays/objects too). */
export function resolveDeep(value: unknown, scope: ExpressionScope, depth = 0): unknown {
  if (depth > 32) throw new ExpressionError('Parameter nesting is too deep');
  if (typeof value === 'string') return hasExpression(value) ? resolveTemplate(value, scope) : value;
  if (Array.isArray(value)) return value.map((v) => resolveDeep(v, scope, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveDeep(v, scope, depth + 1);
    return out;
  }
  return value;
}

/** Static validation for the editor: parse every `{{ }}` and report syntax errors. */
export function validateTemplateSyntax(value: string): string | null {
  for (const m of value.matchAll(TEMPLATE_RE)) {
    try {
      compileExpression(m[1]!.trim());
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }
  const opens = (value.match(/\{\{/g) ?? []).length;
  const closes = (value.match(/\}\}/g) ?? []).length;
  if (opens !== closes) return 'Unbalanced {{ }} braces';
  return null;
}
