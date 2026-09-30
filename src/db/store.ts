import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { migrate } from './migrate.js';
import { BinMatrix, Mask, matrixFromRows, toRows } from '../core/matrix.js';
import { StructElement, MorphOp, BOUNDARY_POLICY } from '../core/morphology.js';
import { Connectivity } from '../core/labeling.js';
import { MeasurementReport } from '../core/regions.js';

export interface ImageRow {
  id: number;
  name: string;
  width: number;
  height: number;
  pixel_height: number;
  pixel_width: number;
  unit: string | null;
  connectivity: number;
  created_at: string;
}

export interface VersionRow {
  id: number;
  image_id: number;
  version: number;
  matrix_json: string;
  mask_json: string | null;
  kind: string;
  note: string | null;
  created_at: string;
}

export interface CreateImageInput {
  name: string;
  matrix: number[][];
  mask?: number[][] | null;
  pixelHeight: number;
  pixelWidth: number;
  unit?: string | null;
  connectivity?: Connectivity;
  idempotencyKey?: string | null;
}

export interface AddStepInput {
  chainId: number;
  imageId: number;
  op: MorphOp | 'merge' | 'filter';
  se?: StructElement | null;
  params: Record<string, unknown>;
  sourceVersionId: number;
  resultMatrix: BinMatrix;
  resultMask?: Mask | null;
  note?: string;
}

export class Store {
  db: DatabaseSync;
  private clock: () => Date;

  constructor(dbPath: string, clock: () => Date = () => new Date()) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.clock = clock;
    migrate(this.db);
  }

  now(): string {
    return this.clock().toISOString();
  }

  close(): void {
    this.db.close();
  }

  getIdempotent(key: string | null | undefined): unknown | null {
    if (!key) return null;
    const row = this.db.prepare('SELECT response_json FROM idempotency WHERE idempotency_key = ?').get(key) as
      | { response_json: string }
      | undefined;
    return row ? JSON.parse(row.response_json) : null;
  }

  putIdempotent(key: string, response: unknown): void {
    this.db
      .prepare('INSERT OR IGNORE INTO idempotency (idempotency_key, response_json, created_at) VALUES (?,?,?)')
      .run(key, JSON.stringify(response), this.now());
  }

  createImage(input: CreateImageInput): { imageId: number; versionId: number; version: number } {
    const matrix = matrixFromRows(input.matrix);
    const insImg = this.db.prepare(
      `INSERT INTO images (name,width,height,pixel_height,pixel_width,unit,connectivity,created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    );
    const info = insImg.run(
      input.name,
      matrix.width,
      matrix.height,
      input.pixelHeight,
      input.pixelWidth,
      input.unit ?? null,
      input.connectivity ?? 8,
      this.now(),
    );
    const imageId = Number(info.lastInsertRowid);
    const insV = this.db.prepare(
      `INSERT INTO image_versions (image_id,version,matrix_json,mask_json,kind,note,created_at)
       VALUES (?,?,?,?,?,?,?)`,
    );
    const vinfo = insV.run(
      imageId,
      1,
      JSON.stringify(toRows(matrix)),
      input.mask ? JSON.stringify(input.mask) : null,
      'original',
      '导入原图',
      this.now(),
    );
    return { imageId, versionId: Number(vinfo.lastInsertRowid), version: 1 };
  }

  getImage(id: number): ImageRow | null {
    return (this.db.prepare('SELECT * FROM images WHERE id=?').get(id) as ImageRow | undefined) ?? null;
  }

  listImages(limit: number, offset: number): { rows: ImageRow[]; total: number } {
    const total = Number((this.db.prepare('SELECT COUNT(*) AS n FROM images').get() as { n: number }).n);
    const rows = this.db.prepare('SELECT * FROM images ORDER BY id ASC LIMIT ? OFFSET ?').all(limit, offset) as unknown as ImageRow[];
    return { rows, total };
  }

  getVersion(id: number): VersionRow | null {
    return (this.db.prepare('SELECT * FROM image_versions WHERE id=?').get(id) as unknown as VersionRow | undefined) ?? null;
  }

  listVersions(imageId: number, limit: number, offset: number): { rows: VersionRow[]; total: number } {
    const total = Number(
      (this.db.prepare('SELECT COUNT(*) AS n FROM image_versions WHERE image_id=?').get(imageId) as { n: number }).n,
    );
    const rows = this.db
      .prepare('SELECT * FROM image_versions WHERE image_id=? ORDER BY version ASC LIMIT ? OFFSET ?')
      .all(imageId, limit, offset) as unknown as VersionRow[];
    return { rows, total };
  }

  latestVersion(imageId: number): VersionRow {
    const row = this.db
      .prepare('SELECT * FROM image_versions WHERE image_id=? ORDER BY version DESC LIMIT 1')
      .get(imageId) as unknown as VersionRow;
    if (!row) throw Object.assign(new Error('图像无版本'), { code: 'NOT_FOUND' });
    return row;
  }

  upsertStructElement(se: StructElement): number {
    this.db
      .prepare(
        `INSERT INTO struct_elements (name,shape_json,anchor_row,anchor_col,created_at)
         VALUES (?,?,?,?,?)
         ON CONFLICT(name) DO UPDATE SET shape_json=excluded.shape_json,
           anchor_row=excluded.anchor_row, anchor_col=excluded.anchor_col`,
      )
      .run(se.name, JSON.stringify(se.shape), se.anchorRow, se.anchorCol, this.now());
    const row = this.db.prepare('SELECT id FROM struct_elements WHERE name=?').get(se.name) as { id: number };
    return row.id;
  }

  getStructElement(name: string): (StructElement & { id: number }) | null {
    const row = this.db
      .prepare('SELECT * FROM struct_elements WHERE name=?')
      .get(name) as
      | { id: number; name: string; shape_json: string; anchor_row: number; anchor_col: number }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      shape: JSON.parse(row.shape_json),
      anchorRow: row.anchor_row,
      anchorCol: row.anchor_col,
    };
  }

  listStructElements(): Array<StructElement & { id: number }> {
    const rows = this.db.prepare('SELECT * FROM struct_elements ORDER BY name ASC').all() as Array<{
      id: number;
      name: string;
      shape_json: string;
      anchor_row: number;
      anchor_col: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      shape: JSON.parse(row.shape_json),
      anchorRow: row.anchor_row,
      anchorCol: row.anchor_col,
    }));
  }

  createChain(imageId: number, name: string, idempotencyKey?: string | null): {
    id: number;
    reused: boolean;
  } {
    if (idempotencyKey) {
      const row = this.db
        .prepare('SELECT id FROM processing_chains WHERE image_id=? AND idempotency_key=?')
        .get(imageId, idempotencyKey) as { id: number } | undefined;
      if (row) return { id: row.id, reused: true };
    }
    const info = this.db
      .prepare('INSERT INTO processing_chains (image_id,name,idempotency_key,created_at) VALUES (?,?,?,?)')
      .run(imageId, name, idempotencyKey ?? null, this.now());
    return { id: Number(info.lastInsertRowid), reused: false };
  }

  /** 在单个事务内写入“结果版本 + 处理步骤”，任一失败整体回滚。 */
  addStep(input: AddStepInput): { stepId: number; resultVersionId: number; version: number } {
    const run = (): { stepId: number; resultVersionId: number; version: number } => {
      const last = this.db
        .prepare('SELECT COALESCE(MAX(version),0) AS v FROM image_versions WHERE image_id=?')
        .get(input.imageId) as { v: number };
      const version = last.v + 1;
      const vinfo = this.db
        .prepare(
          `INSERT INTO image_versions (image_id,version,matrix_json,mask_json,kind,note,created_at)
           VALUES (?,?,?,?,?,?,?)`,
        )
        .run(
          input.imageId,
          version,
          JSON.stringify(toRows(input.resultMatrix)),
          input.resultMask ? JSON.stringify(toRows(input.resultMask)) : null,
          'derived',
          input.note ?? null,
          this.now(),
        );
      const resultVersionId = Number(vinfo.lastInsertRowid);
      const stepNoRow = this.db
        .prepare('SELECT COALESCE(MAX(step_no),0) AS n FROM processing_steps WHERE chain_id=?')
        .get(input.chainId) as { n: number };
      let seId: number | null = null;
      if (input.se) seId = this.upsertStructElement(input.se);
      const sinfo = this.db
        .prepare(
          `INSERT INTO processing_steps
           (chain_id,step_no,op,se_id,params_json,source_version_id,result_version_id,boundary_policy,created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          input.chainId,
          stepNoRow.n + 1,
          input.op,
          seId,
          JSON.stringify(input.params ?? {}),
          input.sourceVersionId,
          resultVersionId,
          BOUNDARY_POLICY,
          this.now(),
        );
      return { stepId: Number(sinfo.lastInsertRowid), resultVersionId, version };
    };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  listSteps(chainId: number): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT ps.*, se.name AS se_name FROM processing_steps ps
         LEFT JOIN struct_elements se ON se.id = ps.se_id
         WHERE ps.chain_id=? ORDER BY step_no ASC`,
      )
      .all(chainId) as Array<Record<string, unknown>>;
  }

  listChains(imageId: number, limit: number, offset: number): { rows: Array<Record<string, unknown>>; total: number } {
    const total = Number(
      (this.db.prepare('SELECT COUNT(*) AS n FROM processing_chains WHERE image_id=?').get(imageId) as { n: number })
        .n,
    );
    const rows = this.db
      .prepare('SELECT * FROM processing_chains WHERE image_id=? ORDER BY id ASC LIMIT ? OFFSET ?')
      .all(imageId, limit, offset) as Array<Record<string, unknown>>;
    return { rows, total };
  }

  saveReport(versionId: number, conn: Connectivity, report: MeasurementReport): number {
    const info = this.db
      .prepare('INSERT INTO reports (version_id,connectivity,report_json,created_at) VALUES (?,?,?,?)')
      .run(versionId, conn, JSON.stringify(report), this.now());
    return Number(info.lastInsertRowid);
  }

  getLatestReport(versionId: number): MeasurementReport | null {
    const row = this.db
      .prepare('SELECT report_json FROM reports WHERE version_id=? ORDER BY id DESC LIMIT 1')
      .get(versionId) as { report_json: string } | undefined;
    return row ? (JSON.parse(row.report_json) as MeasurementReport) : null;
  }
}

export function versionMatrix(v: VersionRow): BinMatrix {
  return matrixFromRows(JSON.parse(v.matrix_json) as number[][]);
}

export function versionMaskRows(v: VersionRow): number[][] | null {
  return v.mask_json ? (JSON.parse(v.mask_json) as number[][]) : null;
}

