import { BinMatrix, Mask, applyMask, cloneMatrix, makeMatrix, idx, toRows, matrixFromRows } from './matrix.js';

/** 人工操作：合并（并集）与过滤（按标签集合保留），均返回新矩阵，不改写原图。 */

/** 两矩阵逐像元并集（人工合并），掩膜外恒为 0。 */
export function unionMatrices(a: BinMatrix, b: BinMatrix, mask: Mask | null = null): BinMatrix {
  if (a.width !== b.width || a.height !== b.height) throw new Error('矩阵尺寸不一致');
  const out = makeMatrix(a.width, a.height);
  for (let i = 0; i < out.data.length; i++) {
    if (mask && mask.data[i] === 0) continue;
    out.data[i] = a.data[i] === 1 || b.data[i] === 1 ? 1 : 0;
  }
  return out;
}

/** 按连通域标签过滤：仅保留 keepLabels 中的区域，返回新矩阵。 */
export function filterByLabels(
  src: BinMatrix,
  labels: Uint32Array,
  keepLabels: Iterable<number>,
): BinMatrix {
  const keep = new Set(keepLabels);
  const out = makeMatrix(src.width, src.height);
  for (let i = 0; i < out.data.length; i++) {
    if (src.data[i] === 1 && keep.has(labels[i])) out.data[i] = 1;
  }
  return out;
}

export interface MatrixDiff {
  added: number[];
  removed: number[];
  unchangedOnes: number;
  addedCount: number;
  removedCount: number;
}

/** 比较处理前后：0->1 为新增，1->0 为消失。 */
export function diffMatrices(before: BinMatrix, after: BinMatrix): MatrixDiff {
  if (before.width !== after.width || before.height !== after.height) throw new Error('矩阵尺寸不一致');
  const added: number[] = [];
  const removed: number[] = [];
  let unchangedOnes = 0;
  for (let i = 0; i < before.data.length; i++) {
    const a = before.data[i];
    const b = after.data[i];
    if (a === 0 && b === 1) added.push(i);
    else if (a === 1 && b === 0) removed.push(i);
    else if (a === 1 && b === 1) unchangedOnes++;
  }
  return { added, removed, unchangedOnes, addedCount: added.length, removedCount: removed.length };
}

export function toCoordinates(indices: number[], width: number): Array<{ row: number; col: number }> {
  return indices.map((i) => ({ row: Math.floor(i / width), col: i % width }));
}

/** 兼容：保证 applyMask 被引用（测试与存储也可直接使用）。 */
export { applyMask, cloneMatrix, idx, toRows, matrixFromRows };
