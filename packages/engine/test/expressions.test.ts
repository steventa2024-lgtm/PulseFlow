import { describe, expect, it } from 'vitest';
import { evaluateExpression, resolveTemplate, validateTemplateSyntax, type ExpressionScope } from '../src';

const scope = (roots: Record<string, unknown> = {}): ExpressionScope => ({
  roots: { $json: { name: 'Ada', n: 3, tags: ['a', 'b'], nested: { deep: { v: 1 } }, empty: '' }, $vars: { prefix: 'x-' }, ...roots },
  fn: { now: () => new Date('2026-03-08T12:00:00Z'), timezone: 'UTC' },
});

describe('expressions', () => {
  it('evaluates arithmetic, comparison, logic and ternaries', () => {
    expect(evaluateExpression('1 + 2 * 3', scope())).toBe(7);
    expect(evaluateExpression('(1 + 2) * 3', scope())).toBe(9);
    expect(evaluateExpression('10 % 4', scope())).toBe(2);
    expect(evaluateExpression('$json.n > 2 && $json.name == "Ada"', scope())).toBe(true);
    expect(evaluateExpression('$json.n < 2 ? "low" : "high"', scope())).toBe('high');
    expect(evaluateExpression('!$json.empty', scope())).toBe(true);
    expect(evaluateExpression('$json.missing ?? "fallback"', scope())).toBe('fallback');
  });

  it('reads nested members, indexes and optional chains', () => {
    expect(evaluateExpression('$json.nested.deep.v', scope())).toBe(1);
    expect(evaluateExpression('$json.tags[1]', scope())).toBe('b');
    expect(evaluateExpression('$json.nope?.deeper', scope())).toBeUndefined();
  });

  it('builds array and object literals', () => {
    expect(evaluateExpression('[1, "two", $json.n]', scope())).toEqual([1, 'two', 3]);
    expect(evaluateExpression('{ a: 1, b: $json.name }', scope())).toEqual({ a: 1, b: 'Ada' });
  });

  it('calls allow-listed functions', () => {
    expect(evaluateExpression('upper($json.name)', scope())).toBe('ADA');
    expect(evaluateExpression('join($json.tags, "+")', scope())).toBe('a+b');
    expect(evaluateExpression('slugify("Hello World!")', scope())).toBe('hello-world');
    expect(evaluateExpression('round(2.345, 2)', scope())).toBe(2.35);
    expect(evaluateExpression('formatDate($now, "yyyy-MM-dd")', scope({ $now: '2026-03-08T12:00:00Z' }))).toBe('2026-03-08');
  });

  it('rejects unknown functions and prototype access', () => {
    expect(() => evaluateExpression('eval("1")', scope())).toThrow();
    expect(() => evaluateExpression('$json.__proto__', scope())).toThrow(/not allowed/);
    expect(() => evaluateExpression('$json.constructor', scope())).toThrow(/not allowed/);
    expect(() => evaluateExpression('$json["constructor"]', scope())).toThrow(/not allowed/);
    expect(() => evaluateExpression('$json.name.constructor.constructor("return process")()', scope())).toThrow();
  });

  it('does not expose inherited properties', () => {
    expect(evaluateExpression('$json.toString', scope())).toBeUndefined();
    expect(evaluateExpression('$json.hasOwnProperty', scope())).toBeUndefined();
  });

  it('resolves templates: exact expressions keep their type, mixed text becomes a string', () => {
    expect(resolveTemplate('{{ $json.n }}', scope())).toBe(3);
    expect(resolveTemplate('{{ $json.tags }}', scope())).toEqual(['a', 'b']);
    expect(resolveTemplate('Hi {{ $json.name }} ({{ $json.n }})', scope())).toBe('Hi Ada (3)');
    expect(resolveTemplate('plain text', scope())).toBe('plain text');
  });

  it('reports syntax errors without evaluating', () => {
    expect(validateTemplateSyntax('{{ 1 + }}')).toMatch(/./);
    expect(validateTemplateSyntax('{{ $json.a }} ok')).toBeNull();
    expect(validateTemplateSyntax('{{ unclosed')).toMatch(/./);
  });
});
