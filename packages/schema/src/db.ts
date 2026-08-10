/**
 * The database seam.
 *
 * One async interface, two adapters. Cloudflare D1 is async and `node:sqlite` is
 * synchronous, so the interface is async and the local adapter resolves
 * immediately — that way every query in the application is written once and runs
 * unchanged against a local file today and D1 later (docs/design.md §5).
 *
 * No ORM: the hand-written SQL migration is already the source of truth because D1
 * needs it, so a second schema definition would only be something to drift from.
 * Safety comes from typed row interfaces plus integration tests that run every
 * query against a real database.
 */

export interface Db {
  all<T>(sql: string, ...params: SqlValue[]): Promise<T[]>;
  first<T>(sql: string, ...params: SqlValue[]): Promise<T | undefined>;
  run(sql: string, ...params: SqlValue[]): Promise<{ lastInsertRowid: number }>;
  /** Executed inside a transaction where the driver supports one. */
  batch(statements: Statement[]): Promise<void>;
}

export type SqlValue = string | number | null;

export interface Statement {
  sql: string;
  params: SqlValue[];
}

export const stmt = (sql: string, ...params: SqlValue[]): Statement => ({ sql, params });
