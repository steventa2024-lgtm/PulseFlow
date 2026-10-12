import type { Item } from '@pulseflow/contracts';
import { NodeError, WaitRequest } from '@pulseflow/engine';
import { cloneJson, combineParam, conditionsParam, defineNode, evaluateConditions, getPath, setPath, toNumber, CONDITION_OPERATORS } from './helpers';

export const setNode = defineNode(
  {
    type: 'core.set',
    displayName: 'Set Fields',
    description: 'Adds or overwrites fields on each item. Values may use expressions such as {{ $json.name }}.',
    category: 'logic',
    icon: 'PencilLine',
    parameters: [
      {
        name: 'fields',
        label: 'Fields',
        type: 'keyvalue',
        default: [],
        description: 'Name supports dot paths (e.g. user.email). A value that is a single {{ }} expression keeps its type.',
      },
      {
        name: 'keepExisting',
        label: 'Keep existing fields',
        type: 'boolean',
        default: true,
        noExpression: true,
      },
    ],
  },
  async (ctx) => {
    const keep = ctx.param<boolean>('keepExisting');
    const out = ctx.items.map((item, i) => {
      const fields = ctx.param<{ name: string; value: unknown }[]>('fields', i) ?? [];
      const json: Record<string, unknown> = keep ? cloneJson(item.json) : {};
      for (const f of fields) {
        if (!f || typeof f.name !== 'string' || !f.name.trim()) continue;
        setPath(json, f.name.trim(), f.value);
      }
      return { json };
    });
    return { main: out };
  },
);

export const ifNode = defineNode(
  {
    type: 'core.if',
    displayName: 'IF / Else',
    description: 'Routes each item to "true" or "false" based on conditions.',
    category: 'logic',
    icon: 'GitBranch',
    outputs: [
      { name: 'true', label: 'True' },
      { name: 'false', label: 'False' },
    ],
    parameters: [conditionsParam(), combineParam],
  },
  async (ctx) => {
    const t: Item[] = [];
    const f: Item[] = [];
    ctx.items.forEach((item, i) => {
      const ok = evaluateConditions(ctx.param('conditions', i), ctx.param('combine', i));
      (ok ? t : f).push(item);
    });
    return { true: t, false: f };
  },
);

export const filterNode = defineNode(
  {
    type: 'core.filter',
    displayName: 'Filter Items',
    description: 'Keeps only items that match the conditions. Others go to the "discarded" output.',
    category: 'logic',
    icon: 'Filter',
    outputs: [
      { name: 'main', label: 'Kept' },
      { name: 'discarded', label: 'Discarded' },
    ],
    parameters: [conditionsParam(), combineParam],
  },
  async (ctx) => {
    const kept: Item[] = [];
    const discarded: Item[] = [];
    ctx.items.forEach((item, i) => (evaluateConditions(ctx.param('conditions', i), ctx.param('combine', i)) ? kept : discarded).push(item));
    return { main: kept, discarded };
  },
);

export const switchNode = defineNode(
  {
    type: 'core.switch',
    displayName: 'Switch',
    description: 'Routes items to the first matching rule (or every matching rule).',
    category: 'logic',
    icon: 'Split',
    outputs: [],
    dynamicOutputs: { param: 'rules', prefix: 'case', fallback: 'fallback' },
    parameters: [
      {
        name: 'rules',
        label: 'Rules',
        type: 'rules',
        required: true,
        default: [{ label: 'Case 1', left: '', operator: 'equals', right: '' }],
        options: CONDITION_OPERATORS,
      },
      {
        name: 'mode',
        label: 'Matching',
        type: 'select',
        default: 'first',
        noExpression: true,
        options: [
          { label: 'First matching rule', value: 'first' },
          { label: 'All matching rules', value: 'all' },
        ],
      },
    ],
  },
  async (ctx) => {
    const rules = (ctx.rawParam('rules') as unknown[]) ?? [];
    const out: Record<string, Item[]> = { fallback: [] };
    rules.forEach((_, i) => (out[`case${i}`] = []));
    const all = ctx.param('mode') === 'all';
    ctx.items.forEach((item, idx) => {
      const resolved = ctx.param<{ left: unknown; operator: string; right: unknown }[]>('rules', idx) ?? [];
      let matched = false;
      for (let i = 0; i < resolved.length; i++) {
        const r = resolved[i]!;
        if (evaluateConditions([r], 'and')) {
          out[`case${i}`]!.push(item);
          matched = true;
          if (!all) break;
        }
      }
      if (!matched) out.fallback!.push(item);
    });
    return out;
  },
);

export const mergeNode = defineNode(
  {
    type: 'core.merge',
    displayName: 'Merge',
    description: 'Combines two branches. Waits for both inputs (a branch that did not run counts as empty).',
    category: 'logic',
    icon: 'Merge',
    inputs: [
      { name: 'a', label: 'Input A' },
      { name: 'b', label: 'Input B' },
    ],
    parameters: [
      {
        name: 'mode',
        label: 'Mode',
        type: 'select',
        default: 'append',
        noExpression: true,
        options: [
          { label: 'Append (A then B)', value: 'append' },
          { label: 'Combine by position', value: 'byIndex' },
          { label: 'Combine by matching field', value: 'byKey' },
          { label: 'Keep only input A', value: 'chooseA' },
          { label: 'Keep only input B', value: 'chooseB' },
        ],
      },
      { name: 'keyA', label: 'Field in A', type: 'string', noExpression: true, showIf: { param: 'mode', equals: ['byKey'] } },
      { name: 'keyB', label: 'Field in B', type: 'string', noExpression: true, showIf: { param: 'mode', equals: ['byKey'] } },
    ],
  },
  async (ctx) => {
    const a = ctx.inputs.a ?? [];
    const b = ctx.inputs.b ?? [];
    const mode = ctx.param<string>('mode');
    switch (mode) {
      case 'byIndex': {
        const n = Math.max(a.length, b.length);
        return { main: Array.from({ length: n }, (_, i) => ({ json: { ...(a[i]?.json ?? {}), ...(b[i]?.json ?? {}) } })) };
      }
      case 'byKey': {
        const ka = ctx.param<string>('keyA');
        const kb = ctx.param<string>('keyB') || ka;
        if (!ka) throw new NodeError('PARAM_REQUIRED', 'Field in A is required');
        const index = new Map<string, Item>();
        for (const it of b) index.set(String(getPath(it.json, kb)), it);
        return { main: a.map((it) => ({ json: { ...it.json, ...(index.get(String(getPath(it.json, ka)))?.json ?? {}) } })) };
      }
      case 'chooseA':
        return { main: a };
      case 'chooseB':
        return { main: b };
      default:
        return { main: [...a, ...b] };
    }
  },
);

export const splitOutNode = defineNode(
  {
    type: 'core.splitOut',
    displayName: 'Split Out',
    description: 'Turns a list field into one item per element.',
    category: 'logic',
    icon: 'ListTree',
    parameters: [
      { name: 'field', label: 'List field', type: 'string', required: true, noExpression: true, placeholder: 'items' },
      { name: 'outputField', label: 'Store primitive values in', type: 'string', default: 'value', noExpression: true },
      { name: 'includeParent', label: 'Copy other fields from parent', type: 'boolean', default: false, noExpression: true },
    ],
  },
  async (ctx) => {
    const field = ctx.param<string>('field');
    const outField = ctx.param<string>('outputField') || 'value';
    const includeParent = ctx.param<boolean>('includeParent');
    const out: Item[] = [];
    for (const item of ctx.items) {
      const list = getPath(item.json, field);
      if (!Array.isArray(list)) continue;
      const parent = includeParent ? { ...item.json } : {};
      if (includeParent) delete parent[field];
      for (const el of list) {
        out.push({ json: el && typeof el === 'object' && !Array.isArray(el) ? { ...parent, ...(el as Record<string, unknown>) } : { ...parent, [outField]: el } });
      }
    }
    return { main: out };
  },
);

export const batchNode = defineNode(
  {
    type: 'core.batch',
    displayName: 'Batch',
    description: 'Groups items into batches of N. Each output item holds a "batch" list.',
    category: 'logic',
    icon: 'Boxes',
    parameters: [{ name: 'size', label: 'Batch size', type: 'number', default: 10, min: 1, max: 100_000 }],
  },
  async (ctx) => {
    const size = Math.max(1, Math.floor(toNumber(ctx.param('size'), 'Batch size')));
    const out: Item[] = [];
    const count = Math.ceil(ctx.items.length / size);
    for (let i = 0; i < count; i++) {
      out.push({ json: { batchIndex: i, batchCount: count, batch: ctx.items.slice(i * size, (i + 1) * size).map((x) => x.json) } });
    }
    return { main: out };
  },
);

export const sortNode = defineNode(
  {
    type: 'core.sort',
    displayName: 'Sort',
    description: 'Sorts items by a field (numbers, dates and text are compared naturally).',
    category: 'logic',
    icon: 'ArrowUpDown',
    parameters: [
      { name: 'field', label: 'Field', type: 'string', required: true, noExpression: true },
      {
        name: 'direction',
        label: 'Direction',
        type: 'select',
        default: 'asc',
        noExpression: true,
        options: [
          { label: 'Ascending', value: 'asc' },
          { label: 'Descending', value: 'desc' },
        ],
      },
    ],
  },
  async (ctx) => {
    const field = ctx.param<string>('field');
    const dir = ctx.param<string>('direction') === 'desc' ? -1 : 1;
    const key = (v: unknown): [number, number | string] => {
      if (v === null || v === undefined || v === '') return [2, 0];
      if (typeof v === 'number') return [0, v];
      const s = String(v);
      if (/^-?\d+(\.\d+)?$/.test(s)) return [0, Number(s)];
      const d = Date.parse(s);
      if (/^\d{4}-\d{2}-\d{2}/.test(s) && !Number.isNaN(d)) return [0, d];
      return [1, s.toLowerCase()];
    };
    const sorted = ctx.items
      .map((item, idx) => ({ item, idx, k: key(getPath(item.json, field)) }))
      .sort((x, y) => {
        // Empty values always sort last regardless of direction.
        if (x.k[0] === 2 || y.k[0] === 2) return x.k[0] === y.k[0] ? x.idx - y.idx : x.k[0] === 2 ? 1 : -1;
        if (x.k[0] !== y.k[0]) return (x.k[0] - y.k[0]) * dir;
        const c = x.k[1] < y.k[1] ? -1 : x.k[1] > y.k[1] ? 1 : 0;
        return c * dir || x.idx - y.idx;
      })
      .map((x) => x.item);
    return { main: sorted };
  },
);

export const dedupeNode = defineNode(
  {
    type: 'core.dedupe',
    displayName: 'Deduplicate',
    description: 'Removes duplicate items within this run, or across runs (remembers keys it has seen).',
    category: 'logic',
    icon: 'CopyMinus',
    permissions: ['kv'],
    outputs: [
      { name: 'main', label: 'New' },
      { name: 'duplicates', label: 'Duplicates' },
    ],
    parameters: [
      { name: 'key', label: 'Key', type: 'string', required: true, default: '{{ $json.id }}', description: 'Expression producing the identity of an item.' },
      {
        name: 'scope',
        label: 'Remember',
        type: 'select',
        default: 'execution',
        noExpression: true,
        options: [
          { label: 'Within this run only', value: 'execution' },
          { label: 'Across all runs (persistent)', value: 'persistent' },
        ],
      },
    ],
  },
  async (ctx) => {
    const persistent = ctx.param('scope') === 'persistent';
    const seen = new Set<string>();
    const fresh: Item[] = [];
    const dups: Item[] = [];
    const freshKeys: string[] = [];
    const scope = `dedupe:${ctx.workflowId}:${ctx.node.id}`;
    for (let i = 0; i < ctx.items.length; i++) {
      const raw = ctx.param('key', i);
      const key = typeof raw === 'string' ? raw : JSON.stringify(raw);
      if (seen.has(key)) {
        dups.push(ctx.items[i]!);
        continue;
      }
      seen.add(key);
      if (persistent && (await ctx.services.dedupe.has(scope, key))) {
        dups.push(ctx.items[i]!);
        continue;
      }
      fresh.push(ctx.items[i]!);
      freshKeys.push(key);
    }
    // Keys are recorded only after the whole batch is classified.
    if (persistent) for (const key of freshKeys) await ctx.services.dedupe.checkAndRecord(scope, key);
    return { main: fresh, duplicates: dups };
  },
);

export const aggregateNode = defineNode(
  {
    type: 'core.aggregate',
    displayName: 'Aggregate',
    description: 'Collects all items into one, or summarizes them (count/sum/avg/min/max) optionally grouped by a field.',
    category: 'logic',
    icon: 'Sigma',
    parameters: [
      {
        name: 'mode',
        label: 'Mode',
        type: 'select',
        default: 'collect',
        noExpression: true,
        options: [
          { label: 'Collect items into a list', value: 'collect' },
          { label: 'Group items by field', value: 'group' },
          { label: 'Summarize', value: 'summarize' },
        ],
      },
      { name: 'outputField', label: 'List field name', type: 'string', default: 'items', noExpression: true, showIf: { param: 'mode', equals: ['collect'] } },
      { name: 'groupBy', label: 'Group by field', type: 'string', noExpression: true, showIf: { param: 'mode', equals: ['summarize', 'group'] } },
      { name: 'valueField', label: 'Value field', type: 'string', noExpression: true, showIf: { param: 'mode', equals: ['summarize'] } },
    ],
  },
  async (ctx) => {
    if (ctx.param('mode') === 'collect') {
      return { main: [{ json: { [ctx.param<string>('outputField') || 'items']: ctx.items.map((i) => i.json), count: ctx.items.length } }] };
    }
    const groupBy = ctx.param<string>('groupBy');
    if (ctx.param('mode') === 'group') {
      if (!groupBy) throw new NodeError('PARAM_REQUIRED', 'Group by field is required');
      const groups = new Map<string, Record<string, unknown>[]>();
      for (const it of ctx.items) {
        const k = String(getPath(it.json, groupBy) ?? '(empty)');
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k)!.push(it.json);
      }
      return { main: [...groups.entries()].map(([key, items]) => ({ json: { key, count: items.length, items } })) };
    }
    const valueField = ctx.param<string>('valueField');
    const groups = new Map<string, number[]>();
    const counts = new Map<string, number>();
    for (const it of ctx.items) {
      const g = groupBy ? String(getPath(it.json, groupBy) ?? '(empty)') : 'all';
      counts.set(g, (counts.get(g) ?? 0) + 1);
      const v = valueField ? Number(getPath(it.json, valueField)) : Number.NaN;
      if (!groups.has(g)) groups.set(g, []);
      if (Number.isFinite(v)) groups.get(g)!.push(v);
    }
    const out: Item[] = [...counts.keys()].map((g) => {
      const vals = groups.get(g) ?? [];
      const sum = vals.reduce((a, b) => a + b, 0);
      return {
        json: {
          ...(groupBy ? { [groupBy]: g } : {}),
          count: counts.get(g),
          ...(valueField
            ? { sum, avg: vals.length ? sum / vals.length : null, min: vals.length ? Math.min(...vals) : null, max: vals.length ? Math.max(...vals) : null }
            : {}),
        },
      };
    });
    return { main: out };
  },
);

const UNIT_MS: Record<string, number> = { seconds: 1000, minutes: 60_000, hours: 3_600_000, days: 86_400_000 };
export const INLINE_WAIT_LIMIT_MS = 5000;

export const waitNode = defineNode(
  {
    type: 'core.wait',
    displayName: 'Wait / Delay',
    description: 'Pauses the run. Waits longer than 5 seconds are durable: they survive app restarts.',
    category: 'logic',
    icon: 'Hourglass',
    parameters: [
      { name: 'amount', label: 'Amount', type: 'number', default: 1, min: 0, max: 1_000_000 },
      {
        name: 'unit',
        label: 'Unit',
        type: 'select',
        default: 'seconds',
        noExpression: true,
        options: Object.keys(UNIT_MS).map((u) => ({ label: u, value: u })),
      },
    ],
  },
  async (ctx) => {
    if (ctx.resumeAt) {
      ctx.log('info', `Resumed after durable wait (scheduled ${ctx.resumeAt.toISOString()})`);
      return { main: ctx.items };
    }
    const ms = toNumber(ctx.param('amount'), 'Amount') * (UNIT_MS[ctx.param<string>('unit')] ?? 1000);
    if (ms <= INLINE_WAIT_LIMIT_MS) {
      await ctx.clock.sleep(ms, ctx.signal);
      return { main: ctx.items };
    }
    throw new WaitRequest(new Date(ctx.clock.now().getTime() + ms));
  },
);

export const stopErrorNode = defineNode(
  {
    type: 'core.stopError',
    displayName: 'Stop and Error',
    description: 'Fails the run with a custom message (use behind an IF to enforce rules).',
    category: 'logic',
    icon: 'OctagonX',
    outputs: [],
    parameters: [
      { name: 'message', label: 'Error message', type: 'string', required: true, default: 'Stopped by workflow' },
      { name: 'code', label: 'Error code', type: 'string', default: 'STOPPED', noExpression: true },
    ],
  },
  async (ctx) => {
    throw new NodeError(ctx.param<string>('code') || 'STOPPED', String(ctx.param('message')));
  },
);

export const executeWorkflowNode = defineNode(
  {
    type: 'core.executeWorkflow',
    displayName: 'Execute Sub-workflow',
    description: 'Runs another workflow (which must start with "Workflow Called") and returns its final items.',
    category: 'logic',
    icon: 'Workflow',
    permissions: ['subworkflow'],
    parameters: [
      { name: 'workflowId', label: 'Workflow', type: 'string', required: true, noExpression: true, description: 'ID of the workflow to call.' },
      {
        name: 'mode',
        label: 'Call',
        type: 'select',
        default: 'once',
        noExpression: true,
        options: [
          { label: 'Once with all items', value: 'once' },
          { label: 'Once per item', value: 'each' },
        ],
      },
    ],
  },
  async (ctx) => {
    const id = ctx.param<string>('workflowId');
    const opts = { depth: ctx.depth + 1, parentExecutionId: ctx.executionId };
    if (ctx.param('mode') === 'each') {
      const out: Item[] = [];
      for (const item of ctx.items) out.push(...(await ctx.services.runSubworkflow(id, [item], opts)));
      return { main: out };
    }
    return { main: await ctx.services.runSubworkflow(id, ctx.items, opts) };
  },
);

export const loopOverItemsNode = defineNode(
  {
    type: 'core.loopOverItems',
    displayName: 'Loop Over Items',
    description: 'Runs a sub-workflow for each batch of items, sequentially, with an iteration cap.',
    category: 'logic',
    icon: 'Repeat',
    permissions: ['subworkflow'],
    parameters: [
      { name: 'workflowId', label: 'Loop body workflow', type: 'string', required: true, noExpression: true },
      { name: 'batchSize', label: 'Items per iteration', type: 'number', default: 1, min: 1, max: 10_000, noExpression: true },
      { name: 'maxIterations', label: 'Max iterations', type: 'number', default: 1000, min: 1, max: 100_000, noExpression: true },
    ],
  },
  async (ctx) => {
    const id = ctx.param<string>('workflowId');
    const size = toNumber(ctx.param('batchSize'), 'Items per iteration');
    const max = toNumber(ctx.param('maxIterations'), 'Max iterations');
    const iterations = Math.ceil(ctx.items.length / size);
    if (iterations > max) throw new NodeError('ITERATION_LIMIT', `Loop needs ${iterations} iterations (limit ${max})`);
    const out: Item[] = [];
    for (let i = 0; i < iterations; i++) {
      if (ctx.signal.aborted) throw new NodeError('CANCELLED', 'Loop cancelled');
      out.push(...(await ctx.services.runSubworkflow(id, ctx.items.slice(i * size, (i + 1) * size), { depth: ctx.depth + 1, parentExecutionId: ctx.executionId })));
    }
    return { main: out };
  },
);

export const logNode = defineNode(
  {
    type: 'core.log',
    displayName: 'Log',
    description: 'Writes a message to the execution log and passes items through unchanged.',
    category: 'logic',
    icon: 'ScrollText',
    parameters: [
      { name: 'message', label: 'Message', type: 'string', default: 'Processed {{ $input.count }} item(s)' },
      {
        name: 'level',
        label: 'Level',
        type: 'select',
        default: 'info',
        noExpression: true,
        options: ['debug', 'info', 'warn', 'error'].map((l) => ({ label: l, value: l })),
      },
      { name: 'perItem', label: 'Log once per item', type: 'boolean', default: false, noExpression: true },
    ],
  },
  async (ctx) => {
    const level = ctx.param<'info'>('level');
    const n = ctx.param<boolean>('perItem') ? ctx.items.length : 1;
    for (let i = 0; i < n; i++) ctx.log(level, String(ctx.param('message', i)));
    return { main: ctx.items };
  },
);

export const noopNode = defineNode(
  {
    type: 'core.noop',
    displayName: 'No Operation',
    description: 'Passes items through. Useful as a junction or placeholder.',
    category: 'logic',
    icon: 'CircleDot',
    parameters: [],
  },
  async (ctx) => ({ main: ctx.items }),
);

export const logicNodes = [
  setNode,
  ifNode,
  filterNode,
  switchNode,
  mergeNode,
  splitOutNode,
  batchNode,
  sortNode,
  dedupeNode,
  aggregateNode,
  waitNode,
  stopErrorNode,
  executeWorkflowNode,
  loopOverItemsNode,
  logNode,
  noopNode,
];
