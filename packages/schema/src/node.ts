/**
 * The local adapter: `node:sqlite`, which ships with Node 22 and needs no native
 * build step. Synchronous under the hood; the async interface is honoured so the
 * same query code runs against D1 unchanged.
 */

import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db, SqlValue, Statement } from './db.ts';

export class NodeDb implements Db {
  readonly raw: DatabaseSync;

  constructor(path: string) {
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.raw.exec('PRAGMA journal_mode = WAL');
  }

  async all<T>(sql: string, ...params: SqlValue[]): Promise<T[]> {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  async first<T>(sql: string, ...params: SqlValue[]): Promise<T | undefined> {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  async run(sql: string, ...params: SqlValue[]): Promise<{ lastInsertRowid: number }> {
    const r = this.raw.prepare(sql).run(...params);
    return { lastInsertRowid: Number(r.lastInsertRowid) };
  }

  async batch(statements: Statement[]): Promise<void> {
    this.raw.exec('BEGIN');
    try {
      for (const s of statements) this.raw.prepare(s.sql).run(...s.params);
      this.raw.exec('COMMIT');
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    }
  }

  close(): void {
    this.raw.close();
  }
}

/**
 * Apply every migration not yet recorded. Deliberately trivial — with one developer
 * and a forward-only schema, a migrations table and lexical ordering is the whole
 * requirement.
 */
export function migrate(db: NodeDb, migrationsDir: string): string[] {
  db.raw.exec(
    `CREATE TABLE IF NOT EXISTS _migration (
       name TEXT PRIMARY KEY,
       applied_at INTEGER NOT NULL
     )`,
  );
  const applied = new Set(
    (db.raw.prepare('SELECT name FROM _migration').all() as { name: string }[]).map((r) => r.name),
  );

  const pending = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) => !applied.has(f));

  for (const file of pending) {
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    db.raw.exec('BEGIN');
    try {
      db.raw.exec(sql);
      db.raw.prepare('INSERT INTO _migration (name, applied_at) VALUES (?, ?)').run(
        file,
        Date.now(),
      );
      db.raw.exec('COMMIT');
    } catch (err) {
      db.raw.exec('ROLLBACK');
      throw new Error(`migration ${file} failed: ${(err as Error).message}`);
    }
  }
  return pending;
}
