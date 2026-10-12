export class ExpressionError extends Error {
  readonly code = 'EXPRESSION_ERROR';
  constructor(
    message: string,
    readonly position?: number,
  ) {
    super(message);
    this.name = 'ExpressionError';
  }
}

type TokenType = 'num' | 'str' | 'ident' | 'op' | 'punc' | 'eof';
interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

export type AstNode =
  | { kind: 'literal'; value: unknown }
  | { kind: 'ident'; name: string }
  | { kind: 'member'; object: AstNode; property: AstNode; computed: boolean; optional: boolean }
  | { kind: 'call'; callee: string; args: AstNode[] }
  | { kind: 'unary'; op: string; arg: AstNode }
  | { kind: 'binary'; op: string; left: AstNode; right: AstNode }
  | { kind: 'conditional'; test: AstNode; then: AstNode; else: AstNode }
  | { kind: 'array'; elements: AstNode[] }
  | { kind: 'object'; entries: { key: string; value: AstNode }[] };

const OPERATORS = ['===', '!==', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '<', '>', '+', '-', '*', '/', '%', '!', '?', ':'];
const MAX_EXPR_LENGTH = 10_000;
const MAX_DEPTH = 64;

export function tokenize(src: string): Token[] {
  if (src.length > MAX_EXPR_LENGTH) throw new ExpressionError('Expression is too long');
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(\d+\.?\d*(e[+-]?\d+)?|\.\d+(e[+-]?\d+)?)/i.exec(src.slice(i));
      tokens.push({ type: 'num', value: m![0], pos: i });
      i += m![0].length;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== ch) {
        if (src[j] === '\\') {
          const next = src[j + 1];
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', "'": "'" };
          out += next !== undefined && next in map ? map[next] : (next ?? '');
          j += 2;
        } else {
          out += src[j];
          j++;
        }
      }
      if (j >= src.length) throw new ExpressionError('Unterminated string', i);
      tokens.push({ type: 'str', value: out, pos: i });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(src.slice(i))!;
      tokens.push({ type: 'ident', value: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (op) {
      // `?.` followed by a digit is a ternary followed by a number (a?.5:1)
      if (op === '?.' && /[0-9]/.test(src[i + 2] ?? '')) {
        tokens.push({ type: 'op', value: '?', pos: i });
        i += 1;
        continue;
      }
      tokens.push({ type: 'op', value: op, pos: i });
      i += op.length;
      continue;
    }
    if ('()[]{},.'.includes(ch)) {
      tokens.push({ type: 'punc', value: ch, pos: i });
      i++;
      continue;
    }
    throw new ExpressionError(`Unexpected character "${ch}"`, i);
  }
  tokens.push({ type: 'eof', value: '', pos: src.length });
  return tokens;
}

const BINARY_PRECEDENCE: Record<string, number> = {
  '??': 1,
  '||': 2,
  '&&': 3,
  '==': 4,
  '!=': 4,
  '===': 4,
  '!==': 4,
  '<': 5,
  '>': 5,
  '<=': 5,
  '>=': 5,
  '+': 6,
  '-': 6,
  '*': 7,
  '/': 7,
  '%': 7,
};

export function parseExpression(src: string): AstNode {
  const tokens = tokenize(src);
  let pos = 0;
  let depth = 0;
  const peek = () => tokens[pos]!;
  const next = () => tokens[pos++]!;
  const expect = (type: TokenType, value?: string) => {
    const t = next();
    if (t.type !== type || (value !== undefined && t.value !== value)) {
      throw new ExpressionError(`Expected ${value ?? type} but found "${t.value || 'end of expression'}"`, t.pos);
    }
    return t;
  };
  const is = (type: TokenType, value?: string) => {
    const t = peek();
    return t.type === type && (value === undefined || t.value === value);
  };

  const parseConditional = (): AstNode => {
    if (++depth > MAX_DEPTH) throw new ExpressionError('Expression nesting is too deep');
    const test = parseBinary(0);
    let result = test;
    if (is('op', '?')) {
      next();
      const thenBranch = parseConditional();
      expect('op', ':');
      const elseBranch = parseConditional();
      result = { kind: 'conditional', test, then: thenBranch, else: elseBranch };
    }
    depth--;
    return result;
  };

  const parseBinary = (minPrec: number): AstNode => {
    let left = parseUnary();
    for (;;) {
      const t = peek();
      const prec = t.type === 'op' ? BINARY_PRECEDENCE[t.value] : undefined;
      if (prec === undefined || prec < minPrec) break;
      next();
      const right = parseBinary(prec + 1);
      left = { kind: 'binary', op: t.value, left, right };
    }
    return left;
  };

  const parseUnary = (): AstNode => {
    if (is('op', '!') || is('op', '-') || is('op', '+')) {
      const op = next().value;
      return { kind: 'unary', op, arg: parseUnary() };
    }
    return parsePostfix(parsePrimary());
  };

  const parsePostfix = (node: AstNode): AstNode => {
    for (;;) {
      if (is('punc', '.')) {
        next();
        const name = expect('ident').value;
        node = { kind: 'member', object: node, property: { kind: 'literal', value: name }, computed: false, optional: false };
      } else if (is('op', '?.')) {
        next();
        if (is('punc', '[')) {
          next();
          const prop = parseConditional();
          expect('punc', ']');
          node = { kind: 'member', object: node, property: prop, computed: true, optional: true };
        } else {
          const name = expect('ident').value;
          node = { kind: 'member', object: node, property: { kind: 'literal', value: name }, computed: false, optional: true };
        }
      } else if (is('punc', '[')) {
        next();
        const prop = parseConditional();
        expect('punc', ']');
        node = { kind: 'member', object: node, property: prop, computed: true, optional: false };
      } else {
        return node;
      }
    }
  };

  const parseArgs = (close: string): AstNode[] => {
    const args: AstNode[] = [];
    if (is('punc', close)) {
      next();
      return args;
    }
    for (;;) {
      args.push(parseConditional());
      if (is('punc', ',')) {
        next();
        continue;
      }
      expect('punc', close);
      return args;
    }
  };

  const parsePrimary = (): AstNode => {
    const t = next();
    switch (t.type) {
      case 'num':
        return { kind: 'literal', value: Number(t.value) };
      case 'str':
        return { kind: 'literal', value: t.value };
      case 'ident': {
        if (t.value === 'true') return { kind: 'literal', value: true };
        if (t.value === 'false') return { kind: 'literal', value: false };
        if (t.value === 'null') return { kind: 'literal', value: null };
        if (t.value === 'undefined') return { kind: 'literal', value: undefined };
        if (is('punc', '(')) {
          next();
          return { kind: 'call', callee: t.value, args: parseArgs(')') };
        }
        return { kind: 'ident', name: t.value };
      }
      case 'punc':
        if (t.value === '(') {
          const inner = parseConditional();
          expect('punc', ')');
          return inner;
        }
        if (t.value === '[') return { kind: 'array', elements: parseArgs(']') };
        if (t.value === '{') {
          const entries: { key: string; value: AstNode }[] = [];
          if (is('punc', '}')) {
            next();
            return { kind: 'object', entries };
          }
          for (;;) {
            const keyTok = next();
            if (keyTok.type !== 'ident' && keyTok.type !== 'str') throw new ExpressionError('Expected object key', keyTok.pos);
            expect('op', ':');
            entries.push({ key: keyTok.value, value: parseConditional() });
            if (is('punc', ',')) {
              next();
              continue;
            }
            expect('punc', '}');
            return { kind: 'object', entries };
          }
        }
        break;
      default:
        break;
    }
    throw new ExpressionError(`Unexpected "${t.value || 'end of expression'}"`, t.pos);
  };

  const ast = parseConditional();
  if (!is('eof')) throw new ExpressionError(`Unexpected "${peek().value}"`, peek().pos);
  return ast;
}
