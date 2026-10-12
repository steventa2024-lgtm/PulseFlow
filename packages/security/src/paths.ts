import fs from 'node:fs';
import path from 'node:path';
import type { FsGrant } from '@pulseflow/contracts';

export class PathPermissionError extends Error {
  readonly code = 'PERMISSION_DENIED';
  constructor(message: string) {
    super(message);
    this.name = 'PathPermissionError';
  }
}

const isWindows = process.platform === 'win32';

function normalizeForCompare(p: string): string {
  const n = path.resolve(p);
  return isWindows ? n.toLowerCase() : n;
}

/** Resolve symlinks for the deepest existing ancestor so links cannot escape a granted scope. */
export function realpathLoose(target: string): string {
  const abs = path.resolve(target);
  const missing: string[] = [];
  let current = abs;
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return missing.length ? path.join(real, ...missing.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return abs;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

export function isWithin(child: string, parent: string): boolean {
  const c = normalizeForCompare(child);
  const p = normalizeForCompare(parent);
  if (c === p) return true;
  const rel = path.relative(p, c);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function assertSafePathSyntax(p: string): void {
  if (typeof p !== 'string' || p.length === 0) throw new PathPermissionError('Path is empty');
  if (p.includes('\0')) throw new PathPermissionError('Path contains a NUL byte');
  if (p.length > 4096) throw new PathPermissionError('Path is too long');
  // Windows device namespaces (\\.\PhysicalDrive0, \\?\GLOBALROOT) bypass normal path rules.
  if (/^\\\\[.?]\\/.test(p) || /^\/\/[.?]\//.test(p)) throw new PathPermissionError('Device paths are not allowed');
}

export interface PathPolicy {
  grants: FsGrant[];
  /** App-owned directories that are always read/write (e.g. the demo directory). */
  appOwned: string[];
}

/**
 * Throws unless `target` is inside a directory the user granted with sufficient access.
 * Returns the resolved absolute path to use for the actual operation.
 */
export function assertPathAllowed(target: string, access: 'read' | 'write', policy: PathPolicy): string {
  assertSafePathSyntax(target);
  if (!path.isAbsolute(target)) {
    throw new PathPermissionError(`Path must be absolute: ${target}`);
  }
  const real = realpathLoose(target);
  for (const owned of policy.appOwned) {
    if (isWithin(real, realpathLoose(owned))) return real;
  }
  for (const grant of policy.grants) {
    if (access === 'write' && grant.access !== 'readwrite') continue;
    if (isWithin(real, realpathLoose(grant.path))) return real;
  }
  throw new PathPermissionError(
    `Access denied: "${target}" is outside the folders this workflow may ${access === 'write' ? 'modify' : 'read'}. ` +
      'Grant the folder in Workflow → Permissions.',
  );
}

/** Rejects file names that would escape their directory or be invalid on Windows. */
export function sanitizeFileName(name: string, replacement = '_'): string {
  let out = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, replacement).replace(/[. ]+$/g, '');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(out)) out = `${replacement}${out}`;
  if (out === '' || out === '.' || out === '..') out = replacement;
  return out.slice(0, 240);
}
