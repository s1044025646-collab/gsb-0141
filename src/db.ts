import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { decodeMatrix, encodeMatrix } from "./matrix.ts";
import type { BinMatrix, LabelReport } from "./types.ts";

export const SCHEMA_VERSION = 1;

/** Idempotent migration: safe to run any number of times. */
export function migrate(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA foreign_keys=ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
      version_no INTEGER NOT NULL,
      parent_version_id INTEGER REFERENCES versions(id),
      kind TEXT NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      data_b64 TEXT NOT NULL,
      mask_b64 TEXT NOT NULL,
      pixel_x REAL NOT NULL,
      pixel_y REAL NOT NULL,
      pixel_unit TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(image_id, version_no)
    );
    CREATE TABLE IF NOT EXISTS structuring_elements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      shape_b64 TEXT NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      anchor_row INTEGER NOT NULL,
      anchor_col INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chains (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
      source_version_id INTEGER NOT NULL REFERENCES versions(id),
      idempotency_key TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(image_id, idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chain_id INTEGER NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      op TEXT NOT NULL,
      params_json TEXT NOT NULL,
      input_version_id INTEGER NOT NULL REFERENCES versions(id),
      output_version_id INTEGER REFERENCES versions(id),
      label_report_json TEXT,
      border_mode TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(chain_id, seq)
    );
  `);
  db.prepare(
    `INSERT INTO schema_meta(key, value) VALUES('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
  ).run(String(SCHEMA_VERSION));
}

export function openDatabase(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  migrate(db);
  return db;
}

export interface StoredVersion {
  id: number;
  imageId: number;
  versionNo: number;
  parentVersionId: number | null;
  kind: string;
  width: number;
  height: number;
  pixelX: number;
  pixelY: number;
  pixelUnit: string;
  createdAt: number;
}

function rowToVersion(row: Record<string, unknown>): StoredVersion {
  return {
    id: Number(row.id),
    imageId: Number(row.image_id),
    versionNo: Number(row.version_no),
    parentVersionId: row.parent_version_id === null ? null : Number(row.parent_version_id),
    kind: String(row.kind),
    width: Number(row.width),
    height: Number(row.height),
    pixelX: Number(row.pixel_x),
    pixelY: Number(row.pixel_y),
    pixelUnit: String(row.pixel_unit),
    createdAt: Number(row.created_at),
  };
}

export interface Repository {
  createImage(name: string, now: number): number;
  upsertSE(input: {
    name: string;
    shape: BinMatrix;
    anchorRow: number;
    anchorCol: number;
    now: number;
  }): number;
  getSEByName(name: string):
    | { id: number; shape: BinMatrix; anchorRow: number; anchorCol: number }
    | undefined;
  addVersion(input: {
    imageId: number;
    parentVersionId: number | null;
    kind: string;
    data: BinMatrix;
    mask: BinMatrix;
    pixelX: number;
    pixelY: number;
    pixelUnit: string;
    now: number;
  }): StoredVersion;
  getVersion(id: number): StoredVersion | undefined;
  getVersionData(id: number): { data: BinMatrix; mask: BinMatrix };
  listVersions(imageId: number): StoredVersion[];
  createChain(imageId: number, sourceVersionId: number, key: string | null, now: number): number;
  findChainByKey(imageId: number, key: string): number | undefined;
  addStep(input: {
    chainId: number;
    seq: number;
    op: string;
    paramsJson: string;
    inputVersionId: number;
    outputVersionId: number;
    report: LabelReport | null;
    borderMode: string;
    now: number;
  }): number;
  listSteps(chainId: number): Array<{
    id: number;
    seq: number;
    op: string;
    paramsJson: string;
    inputVersionId: number;
    outputVersionId: number;
    report: LabelReport | null;
    borderMode: string;
  }>;
  tx<T>(fn: () => T): T;
}

export function createRepository(db: DatabaseSync): Repository {
  return {
    createImage(name, now) {
      const r = db.prepare("INSERT INTO images(name, created_at) VALUES(?, ?)").run(name, now);
      return Number(r.lastInsertRowid);
    },
    upsertSE({ name, shape, anchorRow, anchorCol, now }) {
      const w = shape[0].length;
      const h = shape.length;
      const b64 = encodeMatrix(shape);
      db.prepare(
        `INSERT INTO structuring_elements(name, shape_b64, width, height, anchor_row, anchor_col, created_at)
         VALUES(?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           shape_b64=excluded.shape_b64, width=excluded.width, height=excluded.height,
           anchor_row=excluded.anchor_row, anchor_col=excluded.anchor_col`,
      ).run(name, b64, w, h, anchorRow, anchorCol, now);
      return Number(
        (db.prepare("SELECT id FROM structuring_elements WHERE name=?").get(name) as { id: number }).id,
      );
    },
    getSEByName(name) {
      const row = db
        .prepare(
          "SELECT id, shape_b64, width, height, anchor_row, anchor_col FROM structuring_elements WHERE name=?",
        )
        .get(name) as Record<string, unknown> | undefined;
      if (!row) return undefined;
      return {
        id: Number(row.id),
        shape: decodeMatrix(String(row.shape_b64), Number(row.height), Number(row.width)),
        anchorRow: Number(row.anchor_row),
        anchorCol: Number(row.anchor_col),
      };
    },
    addVersion(v) {
      const max = db
        .prepare("SELECT COALESCE(MAX(version_no), 0) AS n FROM versions WHERE image_id=?")
        .get(v.imageId) as { n: number };
      const versionNo = Number(max.n) + 1;
      const r = db
        .prepare(
          `INSERT INTO versions(image_id, version_no, parent_version_id, kind, width, height,
             data_b64, mask_b64, pixel_x, pixel_y, pixel_unit, created_at)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          v.imageId,
          versionNo,
          v.parentVersionId,
          v.kind,
          v.data[0].length,
          v.data.length,
          encodeMatrix(v.data),
          encodeMatrix(v.mask),
          v.pixelX,
          v.pixelY,
          v.pixelUnit,
          v.now,
        );
      return this.getVersion(Number(r.lastInsertRowid))!;
    },
    getVersion(id) {
      const row = db.prepare("SELECT * FROM versions WHERE id=?").get(id) as
        | Record<string, unknown>
        | undefined;
      return row ? rowToVersion(row) : undefined;
    },
    getVersionData(id) {
      const row = db.prepare("SELECT data_b64, mask_b64, width, height FROM versions WHERE id=?").get(id) as
        | Record<string, unknown>
        | undefined;
      if (!row) throw new Error(`version ${id} not found`);
      const h = Number(row.height);
      const w = Number(row.width);
      return {
        data: decodeMatrix(String(row.data_b64), h, w),
        mask: decodeMatrix(String(row.mask_b64), h, w),
      };
    },
    listVersions(imageId) {
      const rows = db
        .prepare("SELECT * FROM versions WHERE image_id=? ORDER BY version_no")
        .all(imageId) as Record<string, unknown>[];
      return rows.map(rowToVersion);
    },
    createChain(imageId, sourceVersionId, key, now) {
      const r = db
        .prepare(
          "INSERT INTO chains(image_id, source_version_id, idempotency_key, created_at) VALUES(?, ?, ?, ?)",
        )
        .run(imageId, sourceVersionId, key, now);
      return Number(r.lastInsertRowid);
    },
    findChainByKey(imageId, key) {
      const row = db
        .prepare("SELECT id FROM chains WHERE image_id=? AND idempotency_key=?")
        .get(imageId, key) as { id: number } | undefined;
      return row ? Number(row.id) : undefined;
    },
    addStep(s) {
      const r = db
        .prepare(
          `INSERT INTO steps(chain_id, seq, op, params_json, input_version_id, output_version_id,
             label_report_json, border_mode, created_at)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          s.chainId,
          s.seq,
          s.op,
          s.paramsJson,
          s.inputVersionId,
          s.outputVersionId,
          s.report ? JSON.stringify(s.report) : null,
          s.borderMode,
          s.now,
        );
      return Number(r.lastInsertRowid);
    },
    listSteps(chainId) {
      const rows = db
        .prepare("SELECT * FROM steps WHERE chain_id=? ORDER BY seq")
        .all(chainId) as Record<string, unknown>[];
      return rows.map((row) => ({
        id: Number(row.id),
        seq: Number(row.seq),
        op: String(row.op),
        paramsJson: String(row.params_json),
        inputVersionId: Number(row.input_version_id),
        outputVersionId: Number(row.output_version_id),
        report: row.label_report_json ? (JSON.parse(String(row.label_report_json)) as LabelReport) : null,
        borderMode: String(row.border_mode),
      }));
    },
    tx(fn) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const out = fn();
        db.exec("COMMIT");
        return out;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  };
}
