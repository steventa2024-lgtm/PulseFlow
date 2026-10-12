import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { assertPathAllowed, type PathPolicy } from '@pulseflow/security';
import { NodeError } from '../errors';

export interface FileEntry {
  path: string;
  name: string;
  relativePath: string;
  extension: string;
  size: number;
  modifiedAt: string;
  isDirectory: boolean;
}

export interface WriteOptions {
  overwrite?: boolean;
  createDirs?: boolean;
}

export interface ScopedFs {
  readonly policy: PathPolicy;
  resolveRead(p: string): string;
  resolveWrite(p: string): string;
  readText(p: string, maxBytes?: number): Promise<string>;
  writeText(p: string, content: string, options?: WriteOptions): Promise<{ path: string; bytes: number }>;
  writeBytes(p: string, content: Uint8Array, options?: WriteOptions): Promise<{ path: string; bytes: number }>;
  appendText(p: string, content: string): Promise<{ path: string; bytes: number }>;
  exists(p: string): Promise<boolean>;
  stat(p: string): Promise<FileEntry>;
  list(dir: string, options?: { recursive?: boolean; maxEntries?: number; includeDirs?: boolean }): Promise<FileEntry[]>;
  mkdir(dir: string): Promise<void>;
  move(from: string, to: string, options?: { overwrite?: boolean }): Promise<string>;
  copy(from: string, to: string, options?: { overwrite?: boolean }): Promise<string>;
  sha256(p: string): Promise<string>;
}

const DEFAULT_MAX_READ = 50 * 1024 * 1024;

function toEntry(full: string, root: string, st: fs.Stats): FileEntry {
  return {
    path: full,
    name: path.basename(full),
    relativePath: path.relative(root, full).split(path.sep).join('/'),
    extension: path.extname(full).toLowerCase(),
    size: st.size,
    modifiedAt: st.mtime.toISOString(),
    isDirectory: st.isDirectory(),
  };
}

function wrapFsError(err: unknown, op: string, p: string): never {
  if (err instanceof NodeError) throw err;
  const code = (err as NodeJS.ErrnoException).code ?? 'FS_ERROR';
  const friendly: Record<string, string> = {
    ENOENT: 'does not exist',
    EACCES: 'permission denied by the operating system',
    EPERM: 'operation not permitted by the operating system',
    EEXIST: 'already exists',
    EISDIR: 'is a directory',
    ENOTDIR: 'is not a directory',
    EBUSY: 'is busy or locked',
  };
  throw new NodeError(`FS_${code}`, `${op} failed: "${p}" ${friendly[code] ?? (err as Error).message}`, {
    retryable: code === 'EBUSY',
  });
}

/** Filesystem access constrained to granted folders. All node file I/O must go through this. */
export function createScopedFs(policy: PathPolicy): ScopedFs {
  const check = (p: string, access: 'read' | 'write') => {
    try {
      return assertPathAllowed(p, access, policy);
    } catch (e) {
      throw new NodeError('PERMISSION_DENIED', (e as Error).message);
    }
  };

  const api: ScopedFs = {
    policy,
    resolveRead: (p) => check(p, 'read'),
    resolveWrite: (p) => check(p, 'write'),
    async readText(p, maxBytes = DEFAULT_MAX_READ) {
      const real = check(p, 'read');
      try {
        const st = await fsp.stat(real);
        if (st.size > maxBytes) throw new NodeError('FILE_TOO_LARGE', `File ${p} is ${st.size} bytes (limit ${maxBytes})`);
        return await fsp.readFile(real, 'utf8');
      } catch (e) {
        return wrapFsError(e, 'Read', p);
      }
    },
    async writeText(p, content, options = {}) {
      return api.writeBytes(p, Buffer.from(content, 'utf8'), options);
    },
    async writeBytes(p, content, options = {}) {
      const real = check(p, 'write');
      try {
        if (options.createDirs !== false) await fsp.mkdir(path.dirname(real), { recursive: true });
        if (options.overwrite === false && fs.existsSync(real)) {
          throw new NodeError('FILE_EXISTS', `File already exists: ${p}`);
        }
        // Write to a temp file then rename so a crash never leaves a half-written file.
        const tmp = `${real}.${crypto.randomBytes(4).toString('hex')}.tmp`;
        await fsp.writeFile(tmp, content);
        await fsp.rename(tmp, real);
        return { path: real, bytes: content.byteLength };
      } catch (e) {
        return wrapFsError(e, 'Write', p);
      }
    },
    async appendText(p, content) {
      const real = check(p, 'write');
      try {
        await fsp.mkdir(path.dirname(real), { recursive: true });
        await fsp.appendFile(real, content, 'utf8');
        return { path: real, bytes: Buffer.byteLength(content) };
      } catch (e) {
        return wrapFsError(e, 'Append', p);
      }
    },
    async exists(p) {
      const real = check(p, 'read');
      return fs.existsSync(real);
    },
    async stat(p) {
      const real = check(p, 'read');
      try {
        return toEntry(real, path.dirname(real), await fsp.stat(real));
      } catch (e) {
        return wrapFsError(e, 'Stat', p);
      }
    },
    async list(dir, options = {}) {
      const root = check(dir, 'read');
      const max = options.maxEntries ?? 50_000;
      const out: FileEntry[] = [];
      const walk = async (d: string) => {
        let entries: fs.Dirent[];
        try {
          entries = await fsp.readdir(d, { withFileTypes: true });
        } catch (e) {
          return wrapFsError(e, 'List', d);
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const ent of entries) {
          if (out.length >= max) throw new NodeError('TOO_MANY_FILES', `Directory scan exceeded ${max} entries`);
          const full = path.join(d, ent.name);
          if (ent.isSymbolicLink()) continue;
          if (ent.isDirectory()) {
            if (options.includeDirs) out.push(toEntry(full, root, await fsp.stat(full)));
            if (options.recursive) await walk(full);
          } else if (ent.isFile()) {
            out.push(toEntry(full, root, await fsp.stat(full)));
          }
        }
      };
      await walk(root);
      return out;
    },
    async mkdir(dir) {
      const real = check(dir, 'write');
      await fsp.mkdir(real, { recursive: true });
    },
    async move(from, to, options = {}) {
      const src = check(from, 'write');
      const dest = check(to, 'write');
      try {
        if (!options.overwrite && fs.existsSync(dest)) throw new NodeError('FILE_EXISTS', `Destination exists: ${to}`);
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        try {
          await fsp.rename(src, dest);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
          await fsp.copyFile(src, dest);
          await fsp.unlink(src);
        }
        return dest;
      } catch (e) {
        return wrapFsError(e, 'Move', from);
      }
    },
    async copy(from, to, options = {}) {
      const src = check(from, 'read');
      const dest = check(to, 'write');
      try {
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.copyFile(src, dest, options.overwrite ? 0 : fs.constants.COPYFILE_EXCL);
        return dest;
      } catch (e) {
        return wrapFsError(e, 'Copy', from);
      }
    },
    async sha256(p) {
      const real = check(p, 'read');
      return new Promise<string>((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        fs.createReadStream(real)
          .on('data', (chunk) => hash.update(chunk))
          .on('end', () => resolve(hash.digest('hex')))
          .on('error', (e) => {
            try {
              wrapFsError(e, 'Hash', p);
            } catch (err) {
              reject(err);
            }
          });
      });
    },
  };
  return api;
}
