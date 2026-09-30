import { DatabaseSync } from 'node:sqlite';

/**
 * 可重复执行的迁移：全部使用 IF NOT EXISTS，并以 user_version 记录版本。
 */
export const LATEST_SCHEMA_VERSION = 1;

export function migrate(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  const current = Number(db.prepare('PRAGMA user_version').get()!.user_version);

  if (current < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS images (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        pixel_height REAL NOT NULL,
        pixel_width REAL NOT NULL,
        unit TEXT,
        connectivity INTEGER NOT NULL DEFAULT 8,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS image_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        matrix_json TEXT NOT NULL,
        mask_json TEXT,
        kind TEXT NOT NULL DEFAULT 'derived',
        note TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(image_id, version)
      );

      CREATE TABLE IF NOT EXISTS struct_elements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        shape_json TEXT NOT NULL,
        anchor_row INTEGER NOT NULL,
        anchor_col INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS processing_chains (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        idempotency_key TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(image_id, idempotency_key)
      );

      CREATE TABLE IF NOT EXISTS processing_steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chain_id INTEGER NOT NULL REFERENCES processing_chains(id) ON DELETE CASCADE,
        step_no INTEGER NOT NULL,
        op TEXT NOT NULL,
        se_id INTEGER REFERENCES struct_elements(id),
        params_json TEXT NOT NULL DEFAULT '{}',
        source_version_id INTEGER NOT NULL REFERENCES image_versions(id),
        result_version_id INTEGER NOT NULL REFERENCES image_versions(id),
        boundary_policy TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(chain_id, step_no)
      );

      CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version_id INTEGER NOT NULL REFERENCES image_versions(id) ON DELETE CASCADE,
        connectivity INTEGER NOT NULL,
        report_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS idempotency (
        idempotency_key TEXT PRIMARY KEY,
        response_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    db.exec(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION};`);
  }
}
