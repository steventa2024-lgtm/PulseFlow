import { createHash } from "node:crypto";
import { FlowError, isTruthy } from "@pulseflow/contracts";

export type Expr =
  | { type: "lit"; value: string | number | boolean | null }
  | { type: "var"; name: string }
  | { type: "unary"; op: "!" | "-"; expr: Expr }
  | { type: "binary"; op: string; left: Expr; right: Expr }
  | { type: "call"; name: string; args: Expr[] }
  | { type: "array"; items: Expr[] }
  | { type: "object"; entries: Array<{ key: string; value: Expr }> }
  | { type: "postfix"; expr: Expr; ops: Array<{ type: "prop"; name: string } | { type: "index"; expr: Expr }> };

export interface EvalScope {
  [key: string]: unknown;
}

const MAX_EXPR = 8_000;

export function parseExpression(input: string): Expr {
  if (input.length > MAX_EXPR) throw new FlowError("Expression is too long", "EXPR");
  const parser = new Parser(input);
  const expr = parser.parseOr();
  parser.skip();
  if (!parser.eof()) {
    throw new FlowError(`Unexpected expression input at ${parser.index}`, "EXPR");
  }
  assertKnownCalls(expr);
  return expr;
}

const ALLOWED_CALLS = new Set([
  "$node",
  "upper", "lower", "trim", "len", "concat", "coalesce", "number", "string", "bool",
  "json", "parseJson", "split", "join", "replace", "includes", "startsWith", "endsWith", "slice",
  "abs", "min", "max", "round", "floor", "ceil", "keys", "values", "type", "ext", "slug",
  "now", "addDays", "sha256", "if", "match",
]);

function assertKnownCalls(expr: Expr): void {
  if (expr.type === "call" && !ALLOWED_CALLS.has(expr.name)) {
    throw new FlowError(`Unknown function ${expr.name}`, "EXPR");
  }
  if (expr.type === "unary") assertKnownCalls(expr.expr);
  if (expr.type === "binary") {
    assertKnownCalls(expr.left);
    assertKnownCalls(expr.right);
  }
  if (expr.type === "call") for (const arg of expr.args) assertKnownCalls(arg);
  if (expr.type === "array") for (const item of expr.items) assertKnownCalls(item);
  if (expr.type === "object") for (const entry of expr.entries) assertKnownCalls(entry.value);
  if (expr.type === "postfix") {
    assertKnownCalls(expr.expr);
    for (const op of expr.ops) {
      if (op.type === "index") assertKnownCalls(op.expr);
    }
  }
}

class Parser {
  index = 0;
  constructor(private readonly source: string) {}

  eof(): boolean {
    return this.index >= this.source.length;
  }

  skip(): void {
    while (this.index < this.source.length && /\s/.test(this.source[this.index] ?? "")) this.index += 1;
  }

  parseOr(): Expr {
    let left = this.parseAnd();
    while (this.eat("||")) left = { type: "binary", op: "||", left, right: this.parseAnd() };
    return left;
  }

  parseAnd(): Expr {
    let left = this.parseEquality();
    while (this.eat("&&")) left = { type: "binary", op: "&&", left, right: this.parseEquality() };
    return left;
  }

  parseEquality(): Expr {
    let left = this.parseComparison();
    for (;;) {
      if (this.eat("==")) left = { type: "binary", op: "==", left, right: this.parseComparison() };
      else if (this.eat("!=")) left = { type: "binary", op: "!=", left, right: this.parseComparison() };
      else break;
    }
    return left;
  }

  parseComparison(): Expr {
    let left = this.parseAddition();
    for (;;) {
      if (this.eat("<=")) left = { type: "binary", op: "<=", left, right: this.parseAddition() };
      else if (this.eat(">=")) left = { type: "binary", op: ">=", left, right: this.parseAddition() };
      else if (this.eat("<")) left = { type: "binary", op: "<", left, right: this.parseAddition() };
      else if (this.eat(">")) left = { type: "binary", op: ">", left, right: this.parseAddition() };
      else break;
    }
    return left;
  }

  parseAddition(): Expr {
    let left = this.parseMultiply();
    for (;;) {
      if (this.eat("+")) left = { type: "binary", op: "+", left, right: this.parseMultiply() };
      else if (this.eat("-")) left = { type: "binary", op: "-", left, right: this.parseMultiply() };
      else break;
    }
    return left;
  }

  parseMultiply(): Expr {
    let left = this.parseUnary();
    for (;;) {
      if (this.eat("*")) left = { type: "binary", op: "*", left, right: this.parseUnary() };
      else if (this.eat("/")) left = { type: "binary", op: "/", left, right: this.parseUnary() };
      else if (this.eat("%")) left = { type: "binary", op: "%", left, right: this.parseUnary() };
      else break;
    }
    return left;
  }

  parseUnary(): Expr {
    this.skip();
    if (this.eat("!")) return { type: "unary", op: "!", expr: this.parseUnary() };
    if (this.eat("-")) return { type: "unary", op: "-", expr: this.parseUnary() };
    return this.parsePrimary();
  }

  parsePrimary(): Expr {
    this.skip();
    const char = this.source[this.index];
    if (char === "(") {
      this.index += 1;
      const expr = this.parseOr();
      if (!this.eat(")")) throw new FlowError("Expected )", "EXPR");
      return this.parsePostfix(expr);
    }
    if (char === "[") return this.parsePostfix(this.parseArray());
    if (char === "{") return this.parsePostfix(this.parseObject());
    if (char === "\"" || char === "'") return this.parsePostfix(this.parseString());
    if (char !== undefined && /[0-9]/.test(char)) return this.parsePostfix(this.parseNumber());
    if (char !== undefined && /[$A-Za-z_]/.test(char)) return this.parseIdent();
    throw new FlowError(`Unexpected expression character ${char ?? "EOF"}`, "EXPR");
  }

  parseIdent(): Expr {
    const name = this.readIdent();
    this.skip();
    let expr: Expr;
    if (this.source[this.index] === "(") {
      expr = { type: "call", name, args: this.parseArgs() };
    } else if (name === "true") expr = { type: "lit", value: true };
    else if (name === "false") expr = { type: "lit", value: false };
    else if (name === "null") expr = { type: "lit", value: null };
    else expr = { type: "var", name };
    return this.parsePostfix(expr);
  }

  parseArgs(): Expr[] {
    if (!this.eat("(")) throw new FlowError("Expected (", "EXPR");
    const args: Expr[] = [];
    this.skip();
    if (this.eat(")")) return args;
    for (;;) {
      args.push(this.parseOr());
      if (this.eat(")")) break;
      if (!this.eat(",")) throw new FlowError("Expected , or )", "EXPR");
    }
    if (args.length > 32) throw new FlowError("Too many function arguments", "EXPR");
    return args;
  }

  parseArray(): Expr {
    if (!this.eat("[")) throw new FlowError("Expected [", "EXPR");
    const items: Expr[] = [];
    this.skip();
    if (this.eat("]")) return { type: "array", items };
    for (;;) {
      items.push(this.parseOr());
      if (this.eat("]")) break;
      if (!this.eat(",")) throw new FlowError("Expected , or ]", "EXPR");
    }
    return { type: "array", items };
  }

  parseObject(): Expr {
    if (!this.eat("{")) throw new FlowError("Expected {", "EXPR");
    const entries: Array<{ key: string; value: Expr }> = [];
    this.skip();
    if (this.eat("}")) return { type: "object", entries };
    for (;;) {
      this.skip();
      let key: string;
      if (this.source[this.index] === "\"" || this.source[this.index] === "'") {
        const lit = this.parseString();
        if (lit.type !== "lit" || typeof lit.value !== "string") throw new FlowError("Invalid key", "EXPR");
        key = lit.value;
      } else {
        key = this.readIdent();
      }
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        throw new FlowError("Forbidden object key", "EXPR");
      }
      if (!this.eat(":")) throw new FlowError("Expected :", "EXPR");
      entries.push({ key, value: this.parseOr() });
      if (this.eat("}")) break;
      if (!this.eat(",")) throw new FlowError("Expected , or }", "EXPR");
    }
    return { type: "object", entries };
  }

  parseString(): Expr {
    const quote = this.source[this.index];
    if (quote !== "\"" && quote !== "'") throw new FlowError("Expected string", "EXPR");
    this.index += 1;
    let out = "";
    while (this.index < this.source.length) {
      const char = this.source[this.index]!;
      if (char === "\\") {
        const next = this.source[this.index + 1];
        if (next === "n") out += "\n";
        else if (next === "t") out += "\t";
        else if (next === quote || next === "\\") out += next;
        else throw new FlowError("Invalid string escape", "EXPR");
        this.index += 2;
        continue;
      }
      if (char === quote) {
        this.index += 1;
        return { type: "lit", value: out };
      }
      out += char;
      this.index += 1;
    }
    throw new FlowError("Unterminated string", "EXPR");
  }

  parseNumber(): Expr {
    const match = /^(\d+(?:\.\d+)?)/.exec(this.source.slice(this.index));
    if (!match?.[1]) throw new FlowError("Invalid number", "EXPR");
    this.index += match[1].length;
    return { type: "lit", value: Number(match[1]) };
  }

  parsePostfix(expr: Expr): Expr {
    const ops: Array<{ type: "prop"; name: string } | { type: "index"; expr: Expr }> = [];
    for (;;) {
      this.skip();
      if (this.source[this.index] === ".") {
        this.index += 1;
        const name = this.readIdent();
        if (name === "__proto__" || name === "constructor" || name === "prototype") {
          throw new FlowError("Forbidden property access", "EXPR");
        }
        ops.push({ type: "prop", name });
        continue;
      }
      if (this.source[this.index] === "[") {
        this.index += 1;
        const index = this.parseOr();
        if (!this.eat("]")) throw new FlowError("Expected ]", "EXPR");
        ops.push({ type: "index", expr: index });
        continue;
      }
      break;
    }
    return ops.length === 0 ? expr : { type: "postfix", expr, ops };
  }

  readIdent(): string {
    this.skip();
    const match = /^[$A-Za-z_][$A-Za-z0-9_]*/.exec(this.source.slice(this.index));
    if (!match?.[0]) throw new FlowError("Expected identifier", "EXPR");
    this.index += match[0].length;
    return match[0];
  }

  eat(token: string): boolean {
    this.skip();
    if (!this.source.startsWith(token, this.index)) return false;
    const next = this.source[this.index + token.length];
    if (/[$A-Za-z0-9_]/.test(token[0] ?? "") && next && /[$A-Za-z0-9_]/.test(next)) return false;
    if (token === "<" && next === "=") return false;
    if (token === ">" && next === "=") return false;
    if (token === "!" && next === "=") return false;
    if (token === "=" && next === "=") return false;
    if (token === "&" && next !== "&") return false;
    if (token === "|" && next !== "|") return false;
    this.index += token.length;
    return true;
  }
}

export interface EvalContext {
  scope: EvalScope;
  now: () => number;
}

const BLOCKED = new Set(["__proto__", "constructor", "prototype", "eval", "Function"]);

export function evaluate(expr: Expr, ctx: EvalContext, depth = 0): unknown {
  if (depth > 40) throw new FlowError("Expression is too deep", "EXPR");
  switch (expr.type) {
    case "lit":
      return expr.value;
    case "var":
      if (!(expr.name in ctx.scope)) throw new FlowError(`Unknown value ${expr.name}`, "EXPR");
      return ctx.scope[expr.name];
    case "unary": {
      const value = evaluate(expr.expr, ctx, depth + 1);
      if (expr.op === "!") return !isTruthy(value);
      return -asNumber(value);
    }
    case "binary": {
      if (expr.op === "&&") {
        const left = evaluate(expr.left, ctx, depth + 1);
        return isTruthy(left) ? evaluate(expr.right, ctx, depth + 1) : left;
      }
      if (expr.op === "||") {
        const left = evaluate(expr.left, ctx, depth + 1);
        return isTruthy(left) ? left : evaluate(expr.right, ctx, depth + 1);
      }
      const left = evaluate(expr.left, ctx, depth + 1);
      const right = evaluate(expr.right, ctx, depth + 1);
      return binary(expr.op, left, right);
    }
    case "call":
      return applyPostfix(callFunction(expr.name, expr.args.map((arg) => evaluate(arg, ctx, depth + 1)), ctx), [], ctx, depth);
    case "array":
      return expr.items.map((item) => evaluate(item, ctx, depth + 1));
    case "object": {
      const out: Record<string, unknown> = {};
      for (const entry of expr.entries) out[entry.key] = evaluate(entry.value, ctx, depth + 1);
      return out;
    }
    case "postfix": {
      const base = evaluate(expr.expr, ctx, depth + 1);
      return applyPostfix(base, expr.ops, ctx, depth);
    }
    default:
      throw new FlowError("Unsupported expression", "EXPR");
  }
}

function applyPostfix(
  base: unknown,
  ops: Array<{ type: "prop"; name: string } | { type: "index"; expr: Expr }>,
  ctx: EvalContext,
  depth: number,
): unknown {
  let current = base;
  for (const op of ops) {
    if (current === null || current === undefined) {
      throw new FlowError("Cannot read a property of null", "EXPR");
    }
    if (op.type === "prop") {
      if (BLOCKED.has(op.name)) throw new FlowError("Forbidden property", "EXPR");
      if (typeof current !== "object") throw new FlowError("Cannot read a property of a primitive", "EXPR");
      current = (current as Record<string, unknown>)[op.name];
    } else {
      const index = evaluate(op.expr, ctx, depth + 1);
      if (typeof current !== "object") throw new FlowError("Cannot index a primitive", "EXPR");
      current = (current as Record<string, unknown>)[String(index)];
    }
  }
  return current;
}

function callFunction(name: string, args: unknown[], ctx: EvalContext): unknown {
  if (BLOCKED.has(name)) throw new FlowError("Function is not allowed", "EXPR");
  const scoped = ctx.scope[name];
  if (typeof scoped === "function") return (scoped as (...values: unknown[]) => unknown)(...args);
  const fn = FUNCTIONS[name];
  if (!fn) throw new FlowError(`Unknown function ${name}`, "EXPR");
  return fn(args, ctx);
}

function binary(op: string, left: unknown, right: unknown): unknown {
  if (op === "==") return same(left, right);
  if (op === "!=") return !same(left, right);
  if (op === "+" && (typeof left === "string" || typeof right === "string")) return String(left ?? "") + String(right ?? "");
  if (op === "<" || op === ">" || op === "<=" || op === ">=") return compare(op, left, right);
  const a = asNumber(left);
  const b = asNumber(right);
  if (op === "+") return a + b;
  if (op === "-") return a - b;
  if (op === "*") return a * b;
  if (op === "/") {
    if (b === 0) throw new FlowError("Division by zero", "EXPR");
    return a / b;
  }
  if (op === "%") return a % b;
  throw new FlowError(`Unknown operator ${op}`, "EXPR");
}

function compare(op: string, left: unknown, right: unknown): boolean {
  if (typeof left === "string" && typeof right === "string") {
    if (op === "<") return left < right;
    if (op === ">") return left > right;
    if (op === "<=") return left <= right;
    return left >= right;
  }
  const a = asNumber(left);
  const b = asNumber(right);
  if (op === "<") return a < b;
  if (op === ">") return a > b;
  if (op === "<=") return a <= b;
  return a >= b;
}

function same(left: unknown, right: unknown): boolean {
  if (typeof left === "object" || typeof right === "object") {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  return left === right;
}

function asNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  throw new FlowError(`Expected a number, received ${typeof value}`, "EXPR");
}

const FUNCTIONS: Record<string, (args: unknown[], ctx: EvalContext) => unknown> = {
  upper: ([value]) => String(value ?? "").toUpperCase(),
  lower: ([value]) => String(value ?? "").toLowerCase(),
  trim: ([value]) => String(value ?? "").trim(),
  len: ([value]) => (typeof value === "string" || Array.isArray(value) ? value.length : 0),
  concat: (args) => args.map((value) => String(value ?? "")).join(""),
  coalesce: (args) => args.find((value) => value !== null && value !== undefined && value !== "") ?? null,
  number: ([value]) => {
    const parsed = Number(value);
    if (Number.isNaN(parsed)) throw new FlowError("Value is not a number", "EXPR");
    return parsed;
  },
  string: ([value]) => (typeof value === "string" ? value : JSON.stringify(value)),
  bool: ([value]) => isTruthy(value),
  json: ([value]) => JSON.stringify(value),
  parseJson: ([value]) => JSON.parse(String(value ?? "null")),
  split: ([value, sep]) => String(value ?? "").split(String(sep ?? ",")),
  join: ([value, sep]) => (Array.isArray(value) ? value.map((entry) => String(entry)).join(String(sep ?? ",")) : ""),
  replace: ([value, search, replacement]) => String(value ?? "").split(String(search ?? "")).join(String(replacement ?? "")),
  includes: ([value, needle]) => String(value ?? "").includes(String(needle ?? "")),
  startsWith: ([value, needle]) => String(value ?? "").startsWith(String(needle ?? "")),
  endsWith: ([value, needle]) => String(value ?? "").endsWith(String(needle ?? "")),
  slice: ([value, start, end]) => String(value ?? "").slice(Number(start ?? 0), end === undefined ? undefined : Number(end)),
  abs: ([value]) => Math.abs(asNumber(value)),
  min: (args) => Math.min(...args.map((value) => asNumber(value))),
  max: (args) => Math.max(...args.map((value) => asNumber(value))),
  round: ([value]) => Math.round(asNumber(value)),
  floor: ([value]) => Math.floor(asNumber(value)),
  ceil: ([value]) => Math.ceil(asNumber(value)),
  keys: ([value]) => (value && typeof value === "object" ? Object.keys(value as object) : []),
  values: ([value]) => (value && typeof value === "object" ? Object.values(value as object) : []),
  type: ([value]) => (Array.isArray(value) ? "array" : value === null ? "null" : typeof value),
  ext: ([value]) => {
    const base = String(value ?? "").split(/[\\/]/).pop() ?? "";
    const dot = base.lastIndexOf(".");
    return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
  },
  slug: ([value]) =>
    String(value ?? "")
      .normalize("NFKD")
      .replace(/[^\w\s.-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .toLowerCase(),
  now: (_args, ctx) => new Date(ctx.now()).toISOString(),
  addDays: ([value, days]) => {
    const date = new Date(String(value ?? ""));
    if (Number.isNaN(date.getTime())) throw new FlowError("Invalid date", "EXPR");
    date.setUTCDate(date.getUTCDate() + Number(days ?? 0));
    return date.toISOString();
  },
  sha256: ([value]) => createHash("sha256").update(String(value ?? "")).digest("hex"),
  if: ([cond, yes, no]) => (isTruthy(cond) ? yes : no),
  match: ([value, pattern]) => {
    const source = String(value ?? "");
    const raw = String(pattern ?? "");
    if (raw.length > 80 || source.length > 10_000) throw new FlowError("Pattern is too large", "EXPR");
    if (/(\([^)]*[+*][^)]*\))[+*{]/.test(raw)) throw new FlowError("Pattern is not allowed", "EXPR");
    const found = source.match(new RegExp(raw));
    return found ? found[0] : null;
  },
};

export function interpolate(value: unknown, ctx: EvalContext, depth = 0): unknown {
  if (depth > 30) throw new FlowError("Interpolation is too deep", "EXPR");
  if (typeof value === "string") return interpolateString(value, ctx);
  if (Array.isArray(value)) return value.map((entry) => interpolate(entry, ctx, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
      out[key] = interpolate(entry, ctx, depth + 1);
    }
    return out;
  }
  return value;
}

function interpolateString(value: string, ctx: EvalContext): unknown {
  const trimmed = value.trim();
  if (trimmed.startsWith("{{") && trimmed.endsWith("}}") && trimmed.indexOf("{{", 2) === -1) {
    const inner = trimmed.slice(2, -2);
    return evaluate(parseExpression(inner), ctx);
  }
  if (!value.includes("{{")) return value;
  return value.replace(/\{\{([\s\S]+?)\}\}/g, (_match, inner: string) => {
    const result = evaluate(parseExpression(inner), ctx);
    if (result === null || result === undefined) return "";
    return typeof result === "string" ? result : JSON.stringify(result);
  });
}

export function expressionStrings(value: unknown, found: string[] = []): string[] {
  if (typeof value === "string" && value.includes("{{")) {
    const matches = value.matchAll(/\{\{([\s\S]+?)\}\}/g);
    for (const match of matches) {
      if (match[1]) found.push(match[1]);
    }
  } else if (Array.isArray(value)) {
    for (const entry of value) expressionStrings(entry, found);
  } else if (value && typeof value === "object") {
    for (const entry of Object.values(value)) expressionStrings(entry, found);
  }
  return found;
}
