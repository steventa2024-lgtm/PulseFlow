import path from 'node:path';
import type { Item } from '@pulseflow/contracts';
import { NodeError } from '@pulseflow/engine';
import { safeJsonParse, sanitizeFileName } from '@pulseflow/security';
import { cloneJson, defineNode, requireString, setPath } from './helpers';

export const fileReadNode = defineNode(
  {
    type: 'core.fileRead',
    displayName: 'Read File',
    description: 'Reads a text or JSON file from a granted folder.',
    category: 'files',
    icon: 'FileInput',
    permissions: ['fs.read'],
    parameters: [
      { name: 'path', label: 'File path', type: 'path', required: true },
      {
        name: 'format',
        label: 'Format',
        type: 'select',
        default: 'text',
        noExpression: true,
        options: [
          { label: 'Text', value: 'text' },
          { label: 'JSON', value: 'json' },
          { label: 'JSON list → one item per element', value: 'jsonItems' },
        ],
      },
      { name: 'target', label: 'Output field', type: 'string', default: 'content', noExpression: true },
      { name: 'maxKb', label: 'Max size (KB)', type: 'number', default: 10_240, min: 1, max: 512_000, noExpression: true },
    ],
  },
  async (ctx) => {
    const out: Item[] = [];
    for (let i = 0; i < ctx.items.length; i++) {
      const p = requireString(ctx.param('path', i), 'File path');
      const text = await ctx.services.fs.readText(p, ctx.param<number>('maxKb') * 1024);
      const format = ctx.param<string>('format');
      const target = ctx.param<string>('target') || 'content';
      if (format === 'text') {
        const json = cloneJson(ctx.items[i]!.json);
        setPath(json, target, text);
        setPath(json, 'file', { path: p, name: path.basename(p), bytes: Buffer.byteLength(text) });
        out.push({ json });
        continue;
      }
      let parsed: unknown;
      try {
        parsed = safeJsonParse(text);
      } catch (e) {
        throw new NodeError('JSON_PARSE_ERROR', `${path.basename(p)} is not valid JSON: ${(e as Error).message}`);
      }
      if (format === 'jsonItems') {
        const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? Object.values(parsed).find(Array.isArray) : undefined;
        if (!Array.isArray(list)) throw new NodeError('JSON_NOT_LIST', `${path.basename(p)} does not contain a JSON list`);
        for (const el of list) out.push({ json: el && typeof el === 'object' && !Array.isArray(el) ? (el as Record<string, unknown>) : { value: el } });
      } else {
        const json = cloneJson(ctx.items[i]!.json);
        setPath(json, target, parsed);
        out.push({ json });
      }
    }
    return { main: out };
  },
);

async function uniquePath(ctx: { services: { fs: { exists(p: string): Promise<boolean> } } }, target: string): Promise<string> {
  if (!(await ctx.services.fs.exists(target))) return target;
  const ext = path.extname(target);
  const base = target.slice(0, target.length - ext.length);
  for (let n = 1; n < 10_000; n++) {
    const candidate = `${base} (${n})${ext}`;
    if (!(await ctx.services.fs.exists(candidate))) return candidate;
  }
  throw new NodeError('FILE_EXISTS', `Could not find a free file name for ${target}`);
}

export const fileWriteNode = defineNode(
  {
    type: 'core.fileWrite',
    displayName: 'Write File',
    description: 'Writes text or JSON to a file in a granted folder (atomic write; never writes outside grants).',
    category: 'files',
    icon: 'FileOutput',
    permissions: ['fs.write'],
    sideEffects: 'Creates or modifies files on disk.',
    parameters: [
      { name: 'path', label: 'File path', type: 'path', required: true },
      { name: 'content', label: 'Content', type: 'text', default: '{{ $json }}', description: 'Objects are written as formatted JSON.' },
      {
        name: 'mode',
        label: 'If the file exists',
        type: 'select',
        default: 'overwrite',
        noExpression: true,
        options: [
          { label: 'Overwrite', value: 'overwrite' },
          { label: 'Append', value: 'append' },
          { label: 'Fail', value: 'fail' },
          { label: 'Write with a new unique name', value: 'unique' },
        ],
      },
      {
        name: 'perItem',
        label: 'Write once per item',
        type: 'boolean',
        default: false,
        noExpression: true,
        description: 'When off, writes a single file using the first item.',
      },
    ],
  },
  async (ctx) => {
    const count = ctx.param<boolean>('perItem') ? ctx.items.length : Math.min(1, ctx.items.length);
    const out: Item[] = [];
    for (let i = 0; i < count; i++) {
      let p = requireString(ctx.param('path', i), 'File path');
      const raw = ctx.param('content', i);
      const content = typeof raw === 'string' ? raw : `${JSON.stringify(raw, null, 2)}\n`;
      const mode = ctx.param<string>('mode');
      let result: { path: string; bytes: number };
      if (mode === 'append') result = await ctx.services.fs.appendText(p, content);
      else {
        if (mode === 'unique') p = await uniquePath(ctx, p);
        result = await ctx.services.fs.writeText(p, content, { overwrite: mode !== 'fail' });
      }
      ctx.log('info', `Wrote ${result.bytes} bytes to ${result.path}`);
      out.push({ json: { ...ctx.items[i]!.json, file: { path: result.path, bytes: result.bytes, mode } } });
    }
    return { main: out };
  },
);

export const directoryScanNode = defineNode(
  {
    type: 'core.directoryScan',
    displayName: 'Directory Scan',
    description: 'Lists files in a granted folder, optionally recursively and with SHA-256 hashes.',
    category: 'files',
    icon: 'FolderSearch',
    permissions: ['fs.read'],
    parameters: [
      { name: 'folder', label: 'Folder', type: 'path', required: true },
      { name: 'recursive', label: 'Include sub-folders', type: 'boolean', default: false, noExpression: true },
      { name: 'extensions', label: 'Only extensions (e.g. .jpg)', type: 'stringList', default: [], noExpression: true },
      { name: 'includeHash', label: 'Compute SHA-256', type: 'boolean', default: false, noExpression: true },
      { name: 'maxFiles', label: 'Max files', type: 'number', default: 10_000, min: 1, max: 1_000_000, noExpression: true },
    ],
  },
  async (ctx) => {
    const folder = requireString(ctx.param('folder'), 'Folder');
    const exts = (ctx.param<string[]>('extensions') ?? []).map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase());
    const files = (await ctx.services.fs.list(folder, { recursive: ctx.param<boolean>('recursive'), maxEntries: ctx.param<number>('maxFiles') })).filter(
      (f) => exts.length === 0 || exts.includes(f.extension),
    );
    const out: Item[] = [];
    for (const f of files) {
      if (ctx.signal.aborted) throw new NodeError('CANCELLED', 'Scan cancelled');
      out.push({ json: { ...f, folder, ...(ctx.param('includeHash') ? { sha256: await ctx.services.fs.sha256(f.path) } : {}) } });
    }
    ctx.log('info', `Found ${out.length} file(s) in ${folder}`);
    return { main: out };
  },
);

export const fileOpsNode = defineNode(
  {
    type: 'core.fileOps',
    displayName: 'Move / Copy / Rename',
    description: 'Moves, copies or renames files with collision handling and an optional dry-run preview.',
    category: 'files',
    icon: 'FolderInput',
    permissions: ['fs.write'],
    risk: 'sensitive',
    sideEffects: 'Moves or renames your files. Use "Dry run" first to preview.',
    parameters: [
      {
        name: 'operation',
        label: 'Operation',
        type: 'select',
        default: 'move',
        noExpression: true,
        options: [
          { label: 'Move', value: 'move' },
          { label: 'Copy', value: 'copy' },
          { label: 'Rename (same folder)', value: 'rename' },
        ],
      },
      { name: 'source', label: 'Source file', type: 'path', required: true, default: '{{ $json.path }}' },
      { name: 'destination', label: 'Destination folder', type: 'path', showIf: { param: 'operation', equals: ['move', 'copy'] }, required: true },
      { name: 'newName', label: 'New file name', type: 'string', default: '{{ $json.name }}', description: 'Sanitized for Windows/macOS/Linux.' },
      {
        name: 'onConflict',
        label: 'If destination exists',
        type: 'select',
        default: 'rename',
        noExpression: true,
        options: [
          { label: 'Add a number: "name (1).ext"', value: 'rename' },
          { label: 'Skip this file', value: 'skip' },
          { label: 'Fail the run', value: 'fail' },
          { label: 'Overwrite (destructive)', value: 'overwrite' },
        ],
      },
      { name: 'dryRun', label: 'Dry run (preview only, change nothing)', type: 'boolean', default: false },
    ],
  },
  async (ctx) => {
    const out: Item[] = [];
    for (let i = 0; i < ctx.items.length; i++) {
      const op = ctx.param<string>('operation');
      const source = requireString(ctx.param('source', i), 'Source file');
      const dir = op === 'rename' ? path.dirname(source) : requireString(ctx.param('destination', i), 'Destination folder');
      const name = sanitizeFileName(String(ctx.param('newName', i) || path.basename(source)));
      let target = path.join(dir, name);
      const dryRun = ctx.param('dryRun', i) === true || ctx.param('dryRun', i) === 'true';
      const conflict = ctx.param<string>('onConflict');
      ctx.services.fs.resolveWrite(target);
      if (op !== 'copy') ctx.services.fs.resolveWrite(source);
      const same = path.resolve(source) === path.resolve(target);
      let action: string = dryRun ? 'planned' : op === 'copy' ? 'copied' : op === 'rename' ? 'renamed' : 'moved';
      let conflicted = false;
      if (same) {
        out.push({ json: { ...ctx.items[i]!.json, from: source, to: target, action: 'unchanged' } });
        continue;
      }
      if (await ctx.services.fs.exists(target)) {
        conflicted = true;
        if (conflict === 'skip') {
          out.push({ json: { ...ctx.items[i]!.json, from: source, to: target, action: 'skipped', conflict: true } });
          continue;
        }
        if (conflict === 'fail') throw new NodeError('FILE_EXISTS', `Destination already exists: ${target}`);
        if (conflict === 'rename') target = await uniquePath(ctx, target);
      }
      if (!dryRun) {
        if (op === 'copy') await ctx.services.fs.copy(source, target, { overwrite: conflict === 'overwrite' });
        else await ctx.services.fs.move(source, target, { overwrite: conflict === 'overwrite' });
        ctx.log('info', `${action} ${source} → ${target}`);
      } else {
        action = 'planned';
      }
      out.push({ json: { ...ctx.items[i]!.json, from: source, to: target, action, conflict: conflicted, dryRun } });
    }
    return { main: out };
  },
);

export const fileHashNode = defineNode(
  {
    type: 'core.fileHash',
    displayName: 'File Hash',
    description: 'Computes the SHA-256 checksum of a file (e.g. to verify a copy).',
    category: 'files',
    icon: 'Fingerprint',
    permissions: ['fs.read'],
    parameters: [
      { name: 'path', label: 'File path', type: 'path', required: true, default: '{{ $json.path }}' },
      { name: 'target', label: 'Output field', type: 'string', default: 'sha256', noExpression: true },
    ],
  },
  async (ctx) => {
    const out: Item[] = [];
    for (let i = 0; i < ctx.items.length; i++) {
      const json = cloneJson(ctx.items[i]!.json);
      setPath(json, ctx.param<string>('target') || 'sha256', await ctx.services.fs.sha256(requireString(ctx.param('path', i), 'File path')));
      out.push({ json });
    }
    return { main: out };
  },
);

export const notifyNode = defineNode(
  {
    type: 'core.notify',
    displayName: 'Local Notification',
    description: 'Shows a desktop notification (and records it in the PulseFlow notification center).',
    category: 'notify',
    icon: 'Bell',
    permissions: ['notify'],
    parameters: [
      { name: 'title', label: 'Title', type: 'string', default: 'PulseFlow' },
      { name: 'body', label: 'Message', type: 'text', required: true, default: 'Workflow {{ $workflow.name }} finished' },
      { name: 'perItem', label: 'Notify once per item', type: 'boolean', default: false, noExpression: true },
    ],
  },
  async (ctx) => {
    if (!ctx.settings.permissions.notifications) throw new NodeError('PERMISSION_DENIED', 'Notifications are disabled for this workflow (Permissions)');
    const n = ctx.param<boolean>('perItem') ? ctx.items.length : 1;
    for (let i = 0; i < n; i++) {
      const title = String(ctx.param('title', i) ?? 'PulseFlow').slice(0, 200);
      const body = String(ctx.param('body', i) ?? '').slice(0, 2000);
      await ctx.services.notify({ title, body });
    }
    return { main: ctx.items };
  },
);

export const fileNodes = [fileReadNode, fileWriteNode, directoryScanNode, fileOpsNode, fileHashNode, notifyNode];
