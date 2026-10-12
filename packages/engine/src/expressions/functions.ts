import { ExpressionError } from './parser';

export interface FunctionContext {
  now: () => Date;
  timezone: string;
}

type Fn = (ctx: FunctionContext, ...args: unknown[]) => unknown;

const toStr = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

const toNum = (v: unknown): number => {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return Number.NaN;
};

const toArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === null || v === undefined ? [] : [v]);

export function toDate(v: unknown, ctx: FunctionContext): Date {
  if (v === undefined || v === null || v === '') return ctx.now();
  if (v instanceof Date) return v;
  if (typeof v === 'number') return new Date(v);
  const d = new Date(toStr(v));
  if (Number.isNaN(d.getTime())) throw new ExpressionError(`Invalid date: ${toStr(v)}`);
  return d;
}

/** Extracts calendar parts of `date` in a given IANA timezone. */
export function zonedParts(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  return {
    yyyy: parts.year ?? '0000',
    MM: parts.month ?? '01',
    dd: parts.day ?? '01',
    HH: parts.hour === '24' ? '00' : (parts.hour ?? '00'),
    mm: parts.minute ?? '00',
    ss: parts.second ?? '00',
    EEE: parts.weekday ?? '',
  };
}

export function formatDate(date: Date, pattern: string, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  const ms = String(date.getUTCMilliseconds()).padStart(3, '0');
  return pattern.replace(/yyyy|MM|dd|HH|mm|ss|SSS|EEE/g, (tok) => (tok === 'SSS' ? ms : p[tok as keyof typeof p]));
}

const UNIT_MS: Record<string, number> = {
  ms: 1,
  millisecond: 1,
  milliseconds: 1,
  s: 1000,
  second: 1000,
  seconds: 1000,
  m: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
  w: 604_800_000,
  week: 604_800_000,
  weeks: 604_800_000,
};

function slugify(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function safeRegex(pattern: string, flags = ''): RegExp {
  if (pattern.length > 500) throw new ExpressionError('Regex pattern too long');
  if (!/^[gimsuy]*$/.test(flags)) throw new ExpressionError('Invalid regex flags');
  return new RegExp(pattern, flags);
}

export const FUNCTIONS: Record<string, { fn: Fn; signature: string; description: string }> = {
  upper: { fn: (_c, s) => toStr(s).toUpperCase(), signature: 'upper(text)', description: 'Uppercase text' },
  lower: { fn: (_c, s) => toStr(s).toLowerCase(), signature: 'lower(text)', description: 'Lowercase text' },
  trim: { fn: (_c, s) => toStr(s).trim(), signature: 'trim(text)', description: 'Trim whitespace' },
  len: {
    fn: (_c, v) => (typeof v === 'string' || Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : 0),
    signature: 'len(value)',
    description: 'Length of text, list or object',
  },
  concat: { fn: (_c, ...a) => a.map(toStr).join(''), signature: 'concat(a, b, ...)', description: 'Join values as text' },
  join: { fn: (_c, a, sep) => toArr(a).map(toStr).join(sep === undefined ? ',' : toStr(sep)), signature: 'join(list, sep)', description: 'Join list' },
  split: { fn: (_c, s, sep) => toStr(s).split(toStr(sep)), signature: 'split(text, sep)', description: 'Split text' },
  replace: {
    fn: (_c, s, find, rep) => toStr(s).split(toStr(find)).join(toStr(rep)),
    signature: 'replace(text, find, with)',
    description: 'Replace all occurrences',
  },
  replaceRegex: {
    fn: (_c, s, pattern, rep, flags) => toStr(s).replace(safeRegex(toStr(pattern), flags === undefined ? 'g' : toStr(flags)), toStr(rep)),
    signature: 'replaceRegex(text, pattern, with, flags?)',
    description: 'Regex replace',
  },
  matches: {
    fn: (_c, s, pattern, flags) => safeRegex(toStr(pattern), flags === undefined ? '' : toStr(flags)).test(toStr(s)),
    signature: 'matches(text, pattern, flags?)',
    description: 'Regex test',
  },
  contains: {
    fn: (_c, h, n) => (Array.isArray(h) ? h.includes(n) : toStr(h).includes(toStr(n))),
    signature: 'contains(textOrList, value)',
    description: 'Substring / list membership',
  },
  startsWith: { fn: (_c, s, p) => toStr(s).startsWith(toStr(p)), signature: 'startsWith(text, prefix)', description: '' },
  endsWith: { fn: (_c, s, p) => toStr(s).endsWith(toStr(p)), signature: 'endsWith(text, suffix)', description: '' },
  substring: {
    fn: (_c, s, a, b) => toStr(s).substring(toNum(a), b === undefined ? undefined : toNum(b)),
    signature: 'substring(text, start, end?)',
    description: '',
  },
  padStart: { fn: (_c, s, n, f) => toStr(s).padStart(toNum(n), f === undefined ? ' ' : toStr(f)), signature: 'padStart(text, len, fill)', description: '' },
  slugify: { fn: (_c, s) => slugify(toStr(s)), signature: 'slugify(text)', description: 'URL/file safe slug' },
  string: { fn: (_c, v) => toStr(v), signature: 'string(value)', description: 'Convert to text' },
  number: { fn: (_c, v) => toNum(v), signature: 'number(value)', description: 'Convert to number' },
  boolean: {
    fn: (_c, v) => (typeof v === 'string' ? !['', 'false', '0', 'no', 'off'].includes(v.trim().toLowerCase()) : Boolean(v)),
    signature: 'boolean(value)',
    description: 'Convert to boolean',
  },
  json: { fn: (_c, v, indent) => JSON.stringify(v, null, indent === undefined ? undefined : toNum(indent)), signature: 'json(value, indent?)', description: 'Serialize JSON' },
  parseJson: {
    fn: (_c, v) => {
      try {
        return JSON.parse(toStr(v), (k, val: unknown) => (k === '__proto__' || k === 'constructor' ? undefined : val));
      } catch {
        throw new ExpressionError('parseJson: invalid JSON');
      }
    },
    signature: 'parseJson(text)',
    description: 'Parse JSON text',
  },
  default: { fn: (_c, v, d) => (v === null || v === undefined || v === '' ? d : v), signature: 'default(value, fallback)', description: '' },
  isEmpty: {
    fn: (_c, v) =>
      v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && Object.keys(v as object).length === 0),
    signature: 'isEmpty(value)',
    description: '',
  },
  typeOf: { fn: (_c, v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v), signature: 'typeOf(value)', description: '' },
  keys: { fn: (_c, v) => (v && typeof v === 'object' ? Object.keys(v) : []), signature: 'keys(object)', description: '' },
  values: { fn: (_c, v) => (v && typeof v === 'object' ? Object.values(v) : []), signature: 'values(object)', description: '' },
  first: { fn: (_c, v) => toArr(v)[0], signature: 'first(list)', description: '' },
  last: { fn: (_c, v) => toArr(v).at(-1), signature: 'last(list)', description: '' },
  includes: { fn: (_c, a, v) => toArr(a).includes(v), signature: 'includes(list, value)', description: '' },
  unique: { fn: (_c, a) => [...new Set(toArr(a))], signature: 'unique(list)', description: '' },
  pluck: {
    fn: (_c, a, key) => toArr(a).map((x) => (x && typeof x === 'object' ? (x as Record<string, unknown>)[toStr(key)] : undefined)),
    signature: 'pluck(list, key)',
    description: 'Map list of objects to a field',
  },
  sum: { fn: (_c, a) => toArr(a).reduce<number>((acc, x) => acc + (toNum(x) || 0), 0), signature: 'sum(list)', description: '' },
  avg: {
    fn: (_c, a) => {
      const arr = toArr(a);
      return arr.length ? arr.reduce<number>((acc, x) => acc + (toNum(x) || 0), 0) / arr.length : 0;
    },
    signature: 'avg(list)',
    description: '',
  },
  min: { fn: (_c, ...a) => Math.min(...(a.length === 1 && Array.isArray(a[0]) ? a[0] : a).map(toNum)), signature: 'min(...)', description: '' },
  max: { fn: (_c, ...a) => Math.max(...(a.length === 1 && Array.isArray(a[0]) ? a[0] : a).map(toNum)), signature: 'max(...)', description: '' },
  round: {
    fn: (_c, v, d) => {
      const f = 10 ** (d === undefined ? 0 : toNum(d));
      return Math.round(toNum(v) * f) / f;
    },
    signature: 'round(n, digits?)',
    description: '',
  },
  floor: { fn: (_c, v) => Math.floor(toNum(v)), signature: 'floor(n)', description: '' },
  ceil: { fn: (_c, v) => Math.ceil(toNum(v)), signature: 'ceil(n)', description: '' },
  abs: { fn: (_c, v) => Math.abs(toNum(v)), signature: 'abs(n)', description: '' },
  now: { fn: (c) => c.now().toISOString(), signature: 'now()', description: 'Current time (ISO)' },
  timestamp: { fn: (c, d) => toDate(d, c).getTime(), signature: 'timestamp(date?)', description: 'Epoch milliseconds' },
  formatDate: {
    fn: (c, d, pattern, tz) => formatDate(toDate(d, c), pattern === undefined ? 'yyyy-MM-dd' : toStr(pattern), tz === undefined ? c.timezone : toStr(tz)),
    signature: 'formatDate(date, "yyyy-MM-dd HH:mm", tz?)',
    description: 'Format a date in the workflow timezone',
  },
  dateAdd: {
    fn: (c, d, amount, unit) => {
      const u = UNIT_MS[toStr(unit)];
      if (!u) throw new ExpressionError(`dateAdd: unknown unit "${toStr(unit)}"`);
      return new Date(toDate(d, c).getTime() + toNum(amount) * u).toISOString();
    },
    signature: 'dateAdd(date, amount, "days")',
    description: '',
  },
  dateDiff: {
    fn: (c, a, b, unit) => {
      const u = UNIT_MS[unit === undefined ? 'ms' : toStr(unit)];
      if (!u) throw new ExpressionError('dateDiff: unknown unit');
      return (toDate(a, c).getTime() - toDate(b, c).getTime()) / u;
    },
    signature: 'dateDiff(a, b, unit)',
    description: '',
  },
  isBefore: { fn: (c, a, b) => toDate(a, c).getTime() < toDate(b, c).getTime(), signature: 'isBefore(a, b)', description: '' },
  isAfter: { fn: (c, a, b) => toDate(a, c).getTime() > toDate(b, c).getTime(), signature: 'isAfter(a, b)', description: '' },
  basename: {
    fn: (_c, p) => toStr(p).split(/[\\/]/).at(-1) ?? '',
    signature: 'basename(path)',
    description: 'File name portion of a path',
  },
  extname: {
    fn: (_c, p) => {
      const base = toStr(p).split(/[\\/]/).at(-1) ?? '';
      const idx = base.lastIndexOf('.');
      return idx > 0 ? base.slice(idx).toLowerCase() : '';
    },
    signature: 'extname(path)',
    description: 'Lower-case extension including the dot',
  },
  dirname: {
    fn: (_c, p) => {
      const s = toStr(p);
      const idx = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
      return idx <= 0 ? (idx === 0 ? s[0] : '') : s.slice(0, idx);
    },
    signature: 'dirname(path)',
    description: 'Folder portion of a path',
  },
  joinPath: {
    fn: (_c, ...parts) => {
      const strs = parts.map(toStr).filter((s) => s !== '');
      const sep = strs.some((s) => s.includes('\\') && !s.includes('/')) ? '\\' : '/';
      return strs.map((s, i) => (i === 0 ? s.replace(/[\\/]+$/, '') : s.replace(/^[\\/]+|[\\/]+$/g, ''))).join(sep);
    },
    signature: 'joinPath(a, b, ...)',
    description: 'Join path segments',
  },
};

export function callFunction(name: string, ctx: FunctionContext, args: unknown[]): unknown {
  const entry = Object.prototype.hasOwnProperty.call(FUNCTIONS, name) ? FUNCTIONS[name] : undefined;
  if (!entry) throw new ExpressionError(`Unknown function "${name}"`);
  return entry.fn(ctx, ...args);
}
