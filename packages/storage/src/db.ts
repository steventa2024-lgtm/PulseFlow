import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { MIGRATIONS, type Migration } from './migrations';

export type SqlValue = SQLInputValue | boolean | undefined;

function bind(params: SqlValue[]): SQLInputValue[] {
  return params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));
}

/** Thin synchronous wrapper around node:sqlite with WAL mode and migrations. */
export class Database {
  readonly raw: DatabaseSync;
  readonly path: string;
  #txDepth = 0;

  constructor(file: string) {
    this.path = file;
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA foreign_keys = ON;');
    this.raw.exec('PRAGMA busy_timeout = 5000;');
    if (file !== ':memory:') {
      this.raw.exec('PRAGMA journal_mode = WAL;');
      this.raw.exec('PRAGMA synchronous = NORMAL;');
    }
  }

  run(sql: string, ...params: SqlValue[]): { changes: number } {
    const r = this.raw.prepare(sql).run(...bind(params));
    return { changes: Number(r.changes) };
  }

  get<T>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.raw.prepare(sql).get(...bind(params)) as T | undefined;
  }

  all<T>(sql: string, ...params: SqlValue[]): T[] {
    return this.raw.prepare(sql).all(...bind(params)) as T[];
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  /** Runs `fn` atomically. Nested calls join the outer transaction. */
  transaction<T>(fn: () => T): T {
    if (this.#txDepth > 0) return fn();
    this.raw.exec('BEGIN IMMEDIATE');
    this.#txDepth++;
    try {
      const result = fn();
      this.raw.exec('COMMIT');
      return result;
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    } finally {
      this.#txDepth--;
    }
  }

  migrate(migrations: Migration[] = MIGRATIONS): { applied: number[] } {
    this.raw.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
    const done = new Set(this.all<{ id: number }>('SELECT id FROM schema_migrations').map((r) => r.id));
    const applied: number[] = [];
    for (const m of [...migrations].sort((a, b) => a.id - b.id)) {
      if (done.has(m.id)) continue;
      this.transaction(() => {
        this.raw.exec(m.sql);
        this.run('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)', m.id, m.name, new Date().toISOString());
      });
      applied.push(m.id);
    }
    return { applied };
  }

  schemaVersion(): number {
    const row = this.get<{ v: number | null }>('SELECT MAX(id) AS v FROM schema_migrations');
    return row?.v ?? 0;
  }

  /** Consistent online backup using VACUUM INTO (safe while the app is running). */
  backupTo(dest: string): void {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest)) throw new Error(`Backup destination already exists: ${dest}`);
    this.raw.prepare('VACUUM INTO ?').run(dest);
  }

  integrityCheck(): string {
    return this.get<{ integrity_check: string }>('PRAGMA integrity_check')?.integrity_check ?? 'unknown';
  }

  close(): void {
    this.raw.close();
  }
}

export function openDatabase(file: string): Database {
  const db = new Database(file);
  db.migrate();
  return db;
}
