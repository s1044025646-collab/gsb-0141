import { Store } from '../db/store.js';
import { BinMatrix, Mask, matrixFromRows, maskFromRows, toRows, applyMask } from '../core/matrix.js';
import {
  StructElement,
  MorphOp,
  applyMorph,
  validateSe,
} from '../core/morphology.js';
import { Connectivity, labelComponents, labelsToRows } from '../core/labeling.js';
import { measure, MeasurementReport, PixelSize } from '../core/regions.js';
import { diffMatrices, filterByLabels, unionMatrices } from '../core/operations.js';

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export interface StepSpec {
  op: MorphOp | 'merge' | 'filter';
  se?: StructElement | null;
  /** merge: { imageId / versionId }; filter: { keepLabels: number[] } */
  params?: Record<string, unknown>;
  name?: string;
}

export class MorphService {
  constructor(public store: Store) {}

  private pixelSizeOf(imageId: number): PixelSize {
    const img = this.store.getImage(imageId);
    if (!img) throw new ApiError('IMAGE_NOT_FOUND', '图像不存在', 404);
    return { pixelHeight: img.pixel_height, pixelWidth: img.pixel_width, unit: img.unit ?? undefined };
  }

  importImage(input: {
    name: string;
    matrix: number[][];
    mask?: number[][] | null;
    pixelHeight: number;
    pixelWidth: number;
    unit?: string | null;
    connectivity?: Connectivity;
  }): { imageId: number; versionId: number; version: number } {
    if (!input.name || typeof input.name !== 'string') throw new ApiError('INVALID_NAME', 'name 必须为非空字符串');
    if (!Array.isArray(input.matrix) || input.matrix.length === 0 || !Array.isArray(input.matrix[0])) {
      throw new ApiError('INVALID_MATRIX', 'matrix 必须为非空二维 0/1 数组');
    }
    if (!(input.pixelHeight > 0) || !(input.pixelWidth > 0)) {
      throw new ApiError('INVALID_PIXEL_SIZE', '像元尺寸必须为正数');
    }
    const conn = input.connectivity ?? 8;
    if (conn !== 4 && conn !== 8) throw new ApiError('INVALID_CONNECTIVITY', '连通性只能为 4 或 8');
    let matrix: BinMatrix;
    try {
      matrix = matrixFromRows(input.matrix);
    } catch (e) {
      throw new ApiError('INVALID_MATRIX', (e as Error).message);
    }
    let maskRows: number[][] | null = null;
    if (input.mask) {
      try {
        const mask = maskFromRows(input.mask);
        if (mask.width !== matrix.width || mask.height !== matrix.height) {
          throw new Error('掩膜尺寸须与矩阵一致');
        }
        maskRows = input.mask;
      } catch (e) {
        throw new ApiError('INVALID_MASK', (e as Error).message);
      }
    }
    return this.store.createImage({
      name: input.name,
      matrix: input.matrix,
      mask: maskRows,
      pixelHeight: input.pixelHeight,
      pixelWidth: input.pixelWidth,
      unit: input.unit ?? null,
      connectivity: conn,
    });
  }

  /** 执行一条操作链；每步读取上一步结果版本，写入新版本（原图永不改写）。 */
  runChain(input: {
    imageId: number;
    name: string;
    steps: StepSpec[];
    startVersionId?: number;
    idempotencyKey?: string;
  }): { chainId: number; steps: Array<{ stepNo: number; resultVersionId: number; version: number }> } {
    if (input.idempotencyKey) {
      const cached = this.store.getIdempotent(input.idempotencyKey);
      if (cached) return cached as { chainId: number; steps: [] };
    }
    const image = this.store.getImage(input.imageId);
    if (!image) throw new ApiError('IMAGE_NOT_FOUND', '图像不存在', 404);
    if (!Array.isArray(input.steps) || input.steps.length === 0) {
      throw new ApiError('EMPTY_CHAIN', '操作链至少包含一个步骤');
    }
    input.steps.forEach((spec, i) => {
      if (['dilate', 'erode', 'open', 'close'].includes(spec.op)) {
        try {
          if (!spec.se) throw new Error('形态学操作需要结构元素');
          validateSe(spec.se);
        } catch (e) {
          throw new ApiError('INVALID_STRUCT_ELEMENT', `步骤 ${i + 1}: ${(e as Error).message}`);
        }
      } else if (spec.op === 'filter') {
        const keep = (spec.params ?? {}).keepLabels;
        if (!Array.isArray(keep) || !keep.every((x) => Number.isInteger(x) && x > 0)) {
          throw new ApiError('INVALID_FILTER', `步骤 ${i + 1}: keepLabels 必须为正整数数组`);
        }
      } else if (spec.op !== 'merge') {
        throw new ApiError('INVALID_OP', `步骤 ${i + 1}: 未知操作 ${String(spec.op)}`);
      }
    });

    const { id: chainId } = this.store.createChain(input.imageId, input.name, input.idempotencyKey ?? undefined);
    let current =
      input.startVersionId != null
        ? this.store.getVersion(input.startVersionId)
        : this.store.latestVersion(input.imageId);
    if (!current) throw new ApiError('VERSION_NOT_FOUND', '起始版本不存在', 404);
    let currentMatrix: BinMatrix = matrixFromRows(JSON.parse(current.matrix_json));
    const maskRows = current.mask_json ? (JSON.parse(current.mask_json) as number[][]) : null;
    const mask: Mask | null = maskRows ? maskFromRows(maskRows) : null;

    const out: Array<{ stepNo: number; resultVersionId: number; version: number }> = [];
    for (let i = 0; i < input.steps.length; i++) {
      const spec = input.steps[i];
      let result: BinMatrix;
      if (spec.op === 'merge') {
        const otherVersionId = (spec.params ?? {}).versionId as number;
        const otherRow = this.store.getVersion(Number(otherVersionId));
        if (!otherRow || otherRow.image_id !== input.imageId) {
          throw new ApiError('MERGE_VERSION_NOT_FOUND', `步骤 ${i + 1}: 合并来源版本不存在`, 404);
        }
        const other = matrixFromRows(JSON.parse(otherRow.matrix_json));
        result = unionMatrices(currentMatrix, other, mask);
      } else if (spec.op === 'filter') {
        const conn = (image.connectivity === 4 ? 4 : 8) as Connectivity;
        const labels = labelComponents(currentMatrix, conn, mask).labels;
        result = filterByLabels(currentMatrix, labels, ((spec.params ?? {}).keepLabels as number[]) ?? []);
      } else {
        result = applyMorph(spec.op as MorphOp, currentMatrix, spec.se as StructElement, mask);
      }
      const written = this.store.addStep({
        chainId,
        imageId: input.imageId,
        op: spec.op,
        se: spec.se ?? null,
        params: spec.params ?? {},
        sourceVersionId: current.id,
        resultMatrix: result,
        resultMask: mask,
        note: spec.name,
      });
      out.push({ stepNo: i + 1, resultVersionId: written.resultVersionId, version: written.version });
      current = this.store.getVersion(written.resultVersionId)!;
      currentMatrix = result;
    }
    const response = { chainId, steps: out };
    if (input.idempotencyKey) this.store.putIdempotent(input.idempotencyKey, response);
    return response;
  }

  measureVersion(versionId: number, connOverride?: Connectivity): MeasurementReport {
    const v = this.store.getVersion(versionId);
    if (!v) throw new ApiError('VERSION_NOT_FOUND', '版本不存在', 404);
    const img = this.store.getImage(v.image_id)!;
    const conn = connOverride ?? ((img.connectivity === 4 ? 4 : 8) as Connectivity);
    const matrix = matrixFromRows(JSON.parse(v.matrix_json));
    const maskRows = v.mask_json ? (JSON.parse(v.mask_json) as number[][]) : null;
    const mask = maskRows ? maskFromRows(maskRows) : null;
    const report = measure(matrix, conn, this.pixelSizeOf(v.image_id), mask);
    this.store.saveReport(versionId, conn, report);
    return report;
  }

  diffVersions(beforeVersionId: number, afterVersionId: number) {
    const b = this.store.getVersion(beforeVersionId);
    const a = this.store.getVersion(afterVersionId);
    if (!b || !a) throw new ApiError('VERSION_NOT_FOUND', '版本不存在', 404);
    if (b.image_id !== a.image_id) throw new ApiError('DIFFERENT_IMAGES', '只能比较同一图像的版本');
    return diffMatrices(
      matrixFromRows(JSON.parse(b.matrix_json)),
      matrixFromRows(JSON.parse(a.matrix_json)),
    );
  }

  exportLabels(versionId: number, connOverride?: Connectivity): { labels: number[][]; connectivity: Connectivity } {
    const v = this.store.getVersion(versionId);
    if (!v) throw new ApiError('VERSION_NOT_FOUND', '版本不存在', 404);
    const img = this.store.getImage(v.image_id)!;
    const conn = connOverride ?? ((img.connectivity === 4 ? 4 : 8) as Connectivity);
    const matrix = matrixFromRows(JSON.parse(v.matrix_json));
    const maskRows = v.mask_json ? (JSON.parse(v.mask_json) as number[][]) : null;
    const mask = maskRows ? maskFromRows(maskRows) : null;
    return { labels: labelsToRows(labelComponents(matrix, conn, mask)), connectivity: conn };
  }

  /** 从原图出发，按步骤记录重新计算结果，用于历史复现核对（不写库）。 */
  replayChain(chainId: number): { reproduced: boolean; matrices: number[][][] } {
    const steps = this.store.listSteps(chainId);
    if (steps.length === 0) throw new ApiError('CHAIN_NOT_FOUND', '操作链不存在或为空', 404);
    // 只重放本链：从链首步骤的来源版本开始逐步复算。
    // 该来源版本本身（原图或更早链的产物）作为已固定的起点，不重复计算。
    let cursor = this.store.getVersion(Number(steps[0].source_version_id))!;
    let matrix = matrixFromRows(JSON.parse(cursor.matrix_json));
    const maskRows = cursor.mask_json ? (JSON.parse(cursor.mask_json) as number[][]) : null;
    const mask = maskRows ? maskFromRows(maskRows) : null;
    const image = this.store.getImage(cursor.image_id)!;
    const conn = (image.connectivity === 4 ? 4 : 8) as Connectivity;
    const matrices: number[][][] = [];
    let reproduced = true;
    for (const step of steps) {
      const op = step.op as StepSpec['op'];
      if (op === 'merge') {
        const otherId = Number((JSON.parse(String(step.params_json)) as { versionId?: number; mergeVersionId?: number }).versionId ?? (JSON.parse(String(step.params_json)) as { mergeVersionId?: number }).mergeVersionId);
        const other = matrixFromRows(JSON.parse(this.store.getVersion(otherId)!.matrix_json));
        matrix = unionMatrices(matrix, other, mask);
      } else if (op === 'filter') {
        const labels = labelComponents(matrix, conn, mask).labels;
        const keep = (JSON.parse(String(step.params_json)) as { keepLabels: number[] }).keepLabels;
        matrix = filterByLabels(matrix, labels, keep);
      } else {
        const seRow = step.se_id ? this.store.getStructElement(String(step.se_name)) : null;
        let se: StructElement;
        if (seRow) {
          se = { name: seRow.name, shape: seRow.shape, anchorRow: seRow.anchorRow, anchorCol: seRow.anchorCol };
        } else {
          throw new ApiError('SE_NOT_FOUND', '历史步骤缺少结构元素', 500);
        }
        matrix = applyMorph(op as MorphOp, matrix, se, mask);
      }
      matrices.push(toRows(matrix));
      const stored = this.store.getVersion(Number(step.result_version_id))!;
      const storedRows = JSON.parse(stored.matrix_json) as number[][];
      if (JSON.stringify(storedRows) !== JSON.stringify(toRows(matrix))) reproduced = false;
    }
    return { reproduced, matrices };
  }

  /** 保证 applyMask 可通过服务复用。 */
  masked(m: BinMatrix, mask: Mask): BinMatrix {
    return applyMask(m, mask);
  }
}
