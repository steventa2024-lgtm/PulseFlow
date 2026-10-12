import type { Item } from '@pulseflow/contracts';
import { formatDate, NodeError, toDate } from '@pulseflow/engine';
import { safeJsonParse } from '@pulseflow/security';
import { csvToObjects, flatten, objectsToCsv } from './csv';
import { cloneJson, defineNode, getPath, setPath, toNumber } from './helpers';
import { validateJsonSchema } from './json-schema';

export const jsonNode = defineNode(
  {
    type: 'core.json',
    displayName: 'JSON Parse / Stringify',
    description: 'Parses JSON text into data, or serializes data into JSON text.',
    category: 'data',
    icon: 'Braces',
    parameters: [
      {
        name: 'operation',
        label: 'Operation',
        type: 'select',
        default: 'parse',
        noExpression: true,
        options: [
          { label: 'Parse text → data', value: 'parse' },
          { label: 'Stringify data → text', value: 'stringify' },
        ],
      },
      { name: 'source', label: 'Source field', type: 'string', default: 'text', noExpression: true, description: 'Field to read. Use "." for the whole item (stringify only).' },
      { name: 'target', label: 'Target field', type: 'string', default: 'data', noExpression: true, description: 'Use "." to replace the whole item with the parsed object (parse only).' },
      { name: 'pretty', label: 'Pretty print', type: 'boolean', default: true, noExpression: true, showIf: { param: 'operation', equals: ['stringify'] } },
    ],
  },
  async (ctx) => {
    const op = ctx.param<string>('operation');
    const source = ctx.param<string>('source');
    const target = ctx.param<string>('target');
    return {
      main: ctx.items.map((item) => {
        const json = cloneJson(item.json);
        if (op === 'stringify') {
          const v = source === '.' ? item.json : getPath(item.json, source);
          setPath(json, target, JSON.stringify(v, null, ctx.param('pretty') ? 2 : undefined));
          return { json };
        }
        const raw = getPath(item.json, source);
        if (typeof raw !== 'string') throw new NodeError('JSON_PARSE_ERROR', `Field "${source}" is not text`);
        let parsed: unknown;
        try {
          parsed = safeJsonParse(raw);
        } catch (e) {
          throw new NodeError('JSON_PARSE_ERROR', `Invalid JSON in "${source}": ${(e as Error).message}`);
        }
        if (target === '.') {
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new NodeError('JSON_PARSE_ERROR', 'Parsed value is not an object');
          return { json: parsed as Record<string, unknown> };
        }
        setPath(json, target, parsed);
        return { json };
      }),
    };
  },
);

export const csvNode = defineNode(
  {
    type: 'core.csv',
    displayName: 'CSV Parse / Build',
    description: 'Parses CSV text into one item per row, or builds CSV text from items.',
    category: 'data',
    icon: 'Sheet',
    parameters: [
      {
        name: 'operation',
        label: 'Operation',
        type: 'select',
        default: 'parse',
        noExpression: true,
        options: [
          { label: 'Parse CSV → items', value: 'parse' },
          { label: 'Build items → CSV', value: 'build' },
        ],
      },
      { name: 'source', label: 'CSV text field', type: 'string', default: 'content', noExpression: true, showIf: { param: 'operation', equals: ['parse'] } },
      { name: 'delimiter', label: 'Delimiter', type: 'string', default: ',', noExpression: true },
      { name: 'columns', label: 'Columns (optional, in order)', type: 'stringList', default: [], noExpression: true, showIf: { param: 'operation', equals: ['build'] } },
      { name: 'flattenNested', label: 'Flatten nested objects (a.b)', type: 'boolean', default: true, noExpression: true, showIf: { param: 'operation', equals: ['build'] } },
      { name: 'escapeFormulas', label: 'Protect against spreadsheet formula injection', type: 'boolean', default: true, noExpression: true, showIf: { param: 'operation', equals: ['build'] } },
      { name: 'target', label: 'Output field', type: 'string', default: 'csv', noExpression: true, showIf: { param: 'operation', equals: ['build'] } },
    ],
  },
  async (ctx) => {
    const delimiter = ctx.param<string>('delimiter') || ',';
    if (ctx.param('operation') === 'build') {
      const rows = ctx.items.map((i) => (ctx.param('flattenNested') ? flatten(i.json) : i.json));
      const csv = objectsToCsv(rows, { delimiter, columns: ctx.param<string[]>('columns'), escapeFormulas: ctx.param<boolean>('escapeFormulas') });
      return { main: [{ json: { [ctx.param<string>('target') || 'csv']: csv, rowCount: rows.length } }] };
    }
    const source = ctx.param<string>('source');
    const out: Item[] = [];
    for (const item of ctx.items) {
      const text = getPath(item.json, source);
      if (typeof text !== 'string') throw new NodeError('CSV_PARSE_ERROR', `Field "${source}" does not contain CSV text`);
      for (const row of csvToObjects(text, delimiter)) out.push({ json: row });
    }
    return { main: out };
  },
);

export const dateTimeNode = defineNode(
  {
    type: 'core.dateTime',
    displayName: 'Date & Time',
    description: 'Formats, shifts or compares dates in the workflow timezone.',
    category: 'data',
    icon: 'CalendarClock',
    parameters: [
      {
        name: 'operation',
        label: 'Operation',
        type: 'select',
        default: 'format',
        noExpression: true,
        options: [
          { label: 'Format', value: 'format' },
          { label: 'Add / subtract', value: 'add' },
          { label: 'Difference', value: 'diff' },
          { label: 'Current time', value: 'now' },
        ],
      },
      { name: 'value', label: 'Date', type: 'string', default: '{{ $now }}' },
      { name: 'format', label: 'Format', type: 'string', default: 'yyyy-MM-dd HH:mm', noExpression: true, showIf: { param: 'operation', equals: ['format', 'now'] } },
      { name: 'amount', label: 'Amount', type: 'number', default: 1, showIf: { param: 'operation', equals: ['add'] } },
      {
        name: 'unit',
        label: 'Unit',
        type: 'select',
        default: 'days',
        noExpression: true,
        options: ['minutes', 'hours', 'days', 'weeks'].map((u) => ({ label: u, value: u })),
        showIf: { param: 'operation', equals: ['add', 'diff'] },
      },
      { name: 'other', label: 'Compare with', type: 'string', default: '{{ $now }}', showIf: { param: 'operation', equals: ['diff'] } },
      { name: 'target', label: 'Output field', type: 'string', default: 'date', noExpression: true },
    ],
  },
  async (ctx) => {
    const units: Record<string, number> = { minutes: 60_000, hours: 3_600_000, days: 86_400_000, weeks: 604_800_000 };
    const fnCtx = { now: () => ctx.clock.now(), timezone: ctx.settings.timezone };
    return {
      main: ctx.items.map((item, i) => {
        const op = ctx.param<string>('operation');
        const date = op === 'now' ? ctx.clock.now() : toDate(ctx.param('value', i), fnCtx);
        let result: unknown;
        if (op === 'format' || op === 'now') result = formatDate(date, ctx.param<string>('format'), ctx.settings.timezone);
        else if (op === 'add') result = new Date(date.getTime() + toNumber(ctx.param('amount', i), 'Amount') * (units[ctx.param<string>('unit')] ?? 86_400_000)).toISOString();
        else result = (date.getTime() - toDate(ctx.param('other', i), fnCtx).getTime()) / (units[ctx.param<string>('unit')] ?? 86_400_000);
        const json = cloneJson(item.json);
        setPath(json, ctx.param<string>('target') || 'date', result);
        return { json };
      }),
    };
  },
);

export const regexNode = defineNode(
  {
    type: 'core.regex',
    displayName: 'Regex',
    description: 'Tests, extracts, or replaces text with a regular expression.',
    category: 'data',
    icon: 'Regex',
    outputs: [
      { name: 'main', label: 'Matched' },
      { name: 'noMatch', label: 'No match' },
    ],
    parameters: [
      {
        name: 'operation',
        label: 'Operation',
        type: 'select',
        default: 'extract',
        noExpression: true,
        options: [
          { label: 'Extract matches', value: 'extract' },
          { label: 'Test (route by match)', value: 'test' },
          { label: 'Replace', value: 'replace' },
        ],
      },
      { name: 'text', label: 'Text', type: 'string', default: '{{ $json.text }}' },
      { name: 'pattern', label: 'Pattern', type: 'string', required: true, noExpression: true },
      { name: 'flags', label: 'Flags', type: 'string', default: 'i', noExpression: true },
      { name: 'replacement', label: 'Replacement', type: 'string', default: '', showIf: { param: 'operation', equals: ['replace'] } },
      { name: 'target', label: 'Output field', type: 'string', default: 'matches', noExpression: true },
    ],
  },
  async (ctx) => {
    const pattern = ctx.param<string>('pattern');
    const flags = ctx.param<string>('flags') ?? '';
    if (pattern.length > 1000) throw new NodeError('INVALID_REGEX', 'Pattern too long');
    if (!/^[gimsuy]*$/.test(flags)) throw new NodeError('INVALID_REGEX', 'Invalid flags');
    let re: RegExp;
    try {
      re = new RegExp(pattern, flags);
    } catch (e) {
      throw new NodeError('INVALID_REGEX', (e as Error).message);
    }
    const matched: Item[] = [];
    const noMatch: Item[] = [];
    const op = ctx.param<string>('operation');
    const target = ctx.param<string>('target') || 'matches';
    ctx.items.forEach((item, i) => {
      const text = String(ctx.param('text', i) ?? '');
      const json = cloneJson(item.json);
      if (op === 'replace') {
        setPath(json, target, text.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`), String(ctx.param('replacement', i) ?? '')));
        matched.push({ json });
        return;
      }
      const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
      const found = [...text.slice(0, 5_000_000).matchAll(global)].slice(0, 10_000);
      if (found.length === 0) {
        noMatch.push(item);
        return;
      }
      if (op === 'extract') {
        setPath(
          json,
          target,
          found.map((m) => (m.length > 1 ? { match: m[0], groups: m.slice(1), named: m.groups ?? {} } : m[0])),
        );
      }
      matched.push({ json });
    });
    return { main: matched, noMatch };
  },
);

export const textNode = defineNode(
  {
    type: 'core.text',
    displayName: 'Text Transform',
    description: 'Builds or transforms text: template, upper/lower case, trim, slugify, truncate, split lines.',
    category: 'data',
    icon: 'Type',
    parameters: [
      {
        name: 'operation',
        label: 'Operation',
        type: 'select',
        default: 'template',
        noExpression: true,
        options: [
          { label: 'Template', value: 'template' },
          { label: 'Uppercase', value: 'upper' },
          { label: 'Lowercase', value: 'lower' },
          { label: 'Trim', value: 'trim' },
          { label: 'Slugify', value: 'slugify' },
          { label: 'Truncate', value: 'truncate' },
          { label: 'Split lines → items', value: 'lines' },
        ],
      },
      { name: 'text', label: 'Text', type: 'text', default: '{{ $json.text }}' },
      { name: 'maxLength', label: 'Max length', type: 'number', default: 280, showIf: { param: 'operation', equals: ['truncate'] } },
      { name: 'target', label: 'Output field', type: 'string', default: 'text', noExpression: true },
    ],
  },
  async (ctx) => {
    const op = ctx.param<string>('operation');
    const target = ctx.param<string>('target') || 'text';
    const out: Item[] = [];
    ctx.items.forEach((item, i) => {
      const t = String(ctx.param('text', i) ?? '');
      if (op === 'lines') {
        t.split(/\r?\n/)
          .filter((l) => l.trim() !== '')
          .forEach((line, n) => out.push({ json: { lineNumber: n + 1, [target]: line } }));
        return;
      }
      const result =
        op === 'upper'
          ? t.toUpperCase()
          : op === 'lower'
            ? t.toLowerCase()
            : op === 'trim'
              ? t.trim()
              : op === 'slugify'
                ? t.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
                : op === 'truncate'
                  ? (() => {
                      const max = toNumber(ctx.param('maxLength', i), 'Max length');
                      return t.length > max ? `${t.slice(0, Math.max(0, max - 1))}…` : t;
                    })()
                  : t;
      const json = cloneJson(item.json);
      setPath(json, target, result);
      out.push({ json });
    });
    return { main: out };
  },
);

export const mathNode = defineNode(
  {
    type: 'core.math',
    displayName: 'Math',
    description: 'Arithmetic on a numeric field or expression.',
    category: 'data',
    icon: 'Calculator',
    parameters: [
      { name: 'value', label: 'Value', type: 'string', default: '{{ $json.value }}' },
      {
        name: 'operation',
        label: 'Operation',
        type: 'select',
        default: 'add',
        noExpression: true,
        options: [
          { label: 'Add', value: 'add' },
          { label: 'Subtract', value: 'subtract' },
          { label: 'Multiply', value: 'multiply' },
          { label: 'Divide', value: 'divide' },
          { label: 'Modulo', value: 'mod' },
          { label: 'Power', value: 'pow' },
          { label: 'Round', value: 'round' },
          { label: 'Absolute', value: 'abs' },
        ],
      },
      { name: 'operand', label: 'Operand / decimals', type: 'string', default: '0' },
      { name: 'target', label: 'Output field', type: 'string', default: 'result', noExpression: true },
    ],
  },
  async (ctx) => ({
    main: ctx.items.map((item, i) => {
      const a = toNumber(ctx.param('value', i), 'Value');
      const b = toNumber(ctx.param('operand', i), 'Operand');
      const op = ctx.param<string>('operation');
      if (op === 'divide' && b === 0) throw new NodeError('DIVIDE_BY_ZERO', 'Division by zero');
      const r = { add: a + b, subtract: a - b, multiply: a * b, divide: a / b, mod: a % b, pow: a ** b, round: Math.round(a * 10 ** b) / 10 ** b, abs: Math.abs(a) }[op];
      const json = cloneJson(item.json);
      setPath(json, ctx.param<string>('target') || 'result', r);
      return { json };
    }),
  }),
);

export const compareNode = defineNode(
  {
    type: 'core.compareDatasets',
    displayName: 'Compare Datasets',
    description: 'Compares items from A and B by a key field: only in A, only in B, same, different.',
    category: 'data',
    icon: 'GitCompare',
    inputs: [
      { name: 'a', label: 'A' },
      { name: 'b', label: 'B' },
    ],
    outputs: [
      { name: 'onlyA', label: 'Only in A' },
      { name: 'same', label: 'Same' },
      { name: 'different', label: 'Different' },
      { name: 'onlyB', label: 'Only in B' },
    ],
    parameters: [{ name: 'key', label: 'Key field', type: 'string', required: true, noExpression: true }],
  },
  async (ctx) => {
    const key = ctx.param<string>('key');
    const a = ctx.inputs.a ?? [];
    const b = ctx.inputs.b ?? [];
    const bMap = new Map(b.map((it) => [String(getPath(it.json, key)), it]));
    const aKeys = new Set<string>();
    const out = { onlyA: [] as Item[], same: [] as Item[], different: [] as Item[], onlyB: [] as Item[] };
    for (const it of a) {
      const k = String(getPath(it.json, key));
      aKeys.add(k);
      const other = bMap.get(k);
      if (!other) out.onlyA.push(it);
      else if (JSON.stringify(other.json) === JSON.stringify(it.json)) out.same.push(it);
      else out.different.push({ json: { key: k, a: it.json, b: other.json } });
    }
    for (const it of b) if (!aKeys.has(String(getPath(it.json, key)))) out.onlyB.push(it);
    return out;
  },
);

export const kvNode = defineNode(
  {
    type: 'core.kv',
    displayName: 'Key/Value Storage',
    description: 'Persistent storage scoped to this workflow — remember values between runs.',
    category: 'data',
    icon: 'Database',
    permissions: ['kv'],
    parameters: [
      {
        name: 'operation',
        label: 'Operation',
        type: 'select',
        default: 'get',
        noExpression: true,
        options: [
          { label: 'Get', value: 'get' },
          { label: 'Set', value: 'set' },
          { label: 'Delete', value: 'delete' },
          { label: 'Increment', value: 'increment' },
          { label: 'List', value: 'list' },
        ],
      },
      { name: 'key', label: 'Key', type: 'string', required: true, default: 'counter' },
      { name: 'value', label: 'Value', type: 'string', default: '{{ $json }}', showIf: { param: 'operation', equals: ['set'] } },
      { name: 'target', label: 'Output field', type: 'string', default: 'value', noExpression: true },
    ],
  },
  async (ctx) => {
    const op = ctx.param<string>('operation');
    const target = ctx.param<string>('target') || 'value';
    const out: Item[] = [];
    for (let i = 0; i < ctx.items.length; i++) {
      const key = String(ctx.param('key', i));
      const json = cloneJson(ctx.items[i]!.json);
      if (op === 'set') {
        const v = ctx.param('value', i);
        await ctx.services.kv.set(key, v);
        setPath(json, target, v);
      } else if (op === 'delete') {
        await ctx.services.kv.delete(key);
      } else if (op === 'increment') {
        const cur = Number((await ctx.services.kv.get(key)) ?? 0) || 0;
        await ctx.services.kv.set(key, cur + 1);
        setPath(json, target, cur + 1);
      } else if (op === 'list') {
        setPath(json, target, await ctx.services.kv.list(key === '*' ? '' : key));
      } else {
        setPath(json, target, (await ctx.services.kv.get(key)) ?? null);
      }
      out.push({ json });
    }
    return { main: out };
  },
);

export const envNode = defineNode(
  {
    type: 'core.env',
    displayName: 'Environment Variables',
    description: 'Reads environment variables that you explicitly allow in Settings → Environment.',
    category: 'data',
    icon: 'KeyRound',
    parameters: [{ name: 'names', label: 'Variable names', type: 'stringList', required: true, noExpression: true }],
  },
  async (ctx) => {
    const names = ctx.param<string[]>('names') ?? [];
    const values: Record<string, string | null> = {};
    for (const n of names) {
      if (!(n in ctx.services.env)) throw new NodeError('ENV_NOT_ALLOWED', `Environment variable "${n}" is not on the allow-list (Settings → Environment)`);
      values[n] = ctx.services.env[n] ?? null;
    }
    return { main: ctx.items.map((it) => ({ json: { ...it.json, env: values } })) };
  },
);

export const markdownNode = defineNode(
  {
    type: 'core.markdown',
    displayName: 'Markdown Builder',
    description: 'Builds one Markdown document from all items: title, intro, one line per item, footer.',
    category: 'data',
    icon: 'FileText',
    parameters: [
      { name: 'title', label: 'Title', type: 'string', default: 'Report — {{ $today }}' },
      { name: 'intro', label: 'Intro', type: 'text', default: '' },
      { name: 'itemTemplate', label: 'Line per item', type: 'text', default: '- {{ $json.title }}', description: 'Evaluated once per item.' },
      { name: 'emptyText', label: 'Text when there are no items', type: 'string', default: '_Nothing to report._' },
      { name: 'footer', label: 'Footer', type: 'text', default: '' },
      { name: 'target', label: 'Output field', type: 'string', default: 'markdown', noExpression: true },
    ],
  },
  async (ctx) => {
    const lines: string[] = [];
    const title = String(ctx.param('title') ?? '').trim();
    if (title) lines.push(`# ${title}`, '');
    const intro = String(ctx.param('intro') ?? '').trim();
    if (intro) lines.push(intro, '');
    const realItems = ctx.items.filter((i) => Object.keys(i.json).length > 0 && !i.json.__empty);
    if (realItems.length === 0) lines.push(String(ctx.param('emptyText') ?? ''));
    const template = String(ctx.rawParam('itemTemplate') ?? '');
    for (let i = 0; i < ctx.items.length; i++) {
      if (!realItems.includes(ctx.items[i]!)) continue;
      lines.push(String(ctx.evaluate(template, i) ?? ''));
    }
    const footer = String(ctx.param('footer') ?? '').trim();
    if (footer) lines.push('', footer);
    const markdown = `${lines.join('\n').trimEnd()}\n`;
    return { main: [{ json: { [ctx.param<string>('target') || 'markdown']: markdown, itemCount: realItems.length } }] };
  },
);

export const schemaValidateNode = defineNode(
  {
    type: 'core.jsonSchemaValidate',
    displayName: 'Validate JSON Schema',
    description: 'Checks items against a JSON Schema; invalid items go to the "invalid" output with reasons.',
    category: 'data',
    icon: 'ShieldCheck',
    outputs: [
      { name: 'main', label: 'Valid' },
      { name: 'invalid', label: 'Invalid' },
    ],
    parameters: [
      { name: 'schema', label: 'Schema', type: 'json', required: true, noExpression: true, default: { type: 'object', required: [], properties: {} } },
      { name: 'field', label: 'Validate field (blank = whole item)', type: 'string', default: '', noExpression: true },
    ],
  },
  async (ctx) => {
    const schema = ctx.rawParam('schema');
    if (!schema || typeof schema !== 'object') throw new NodeError('INVALID_SCHEMA', 'Schema must be a JSON object');
    const field = ctx.param<string>('field');
    const valid: Item[] = [];
    const invalid: Item[] = [];
    for (const item of ctx.items) {
      const errors = validateJsonSchema(field ? getPath(item.json, field) : item.json, schema as Record<string, unknown>);
      if (errors.length) invalid.push({ json: { ...item.json, validationErrors: errors } });
      else valid.push(item);
    }
    return { main: valid, invalid };
  },
);

export const dataNodes = [jsonNode, csvNode, dateTimeNode, regexNode, textNode, mathNode, compareNode, kvNode, envNode, markdownNode, schemaValidateNode];
