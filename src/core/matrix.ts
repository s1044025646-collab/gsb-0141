/**
 * 二值矩阵：行优先存储，0 = 背景，1 = 前景。
 * 掩膜与矩阵同尺寸；mask=0 的像元位于“有效区域”之外，
 * 不参与任何集合运算、连通判定与面积统计。
 */
export interface BinMatrix {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface Mask {
  width: number;
  height: number;
  data: Uint8Array;
}

export function idx(m: { width: number }, r: number, c: number): number {
  return r * m.width + c;
}

export function makeMatrix(width: number, height: number): BinMatrix {
  return { width, height, data: new Uint8Array(width * height) };
}

export function fullMask(width: number, height: number): Mask {
  return { width, height, data: new Uint8Array(width * height).fill(1) };
}

export function matrixFromRows(rows: number[][]): BinMatrix {
  const height = rows.length;
  const width = height === 0 ? 0 : rows[0].length;
  const m = makeMatrix(width, height);
  for (let r = 0; r < height; r++) {
    if (rows[r].length !== width) throw new Error('行列长度不一致');
    for (let c = 0; c < width; c++) {
      if (rows[r][c] !== 0 && rows[r][c] !== 1) throw new Error('只允许 0/1');
      m.data[idx(m, r, c)] = rows[r][c];
    }
  }
  return m;
}

export function maskFromRows(rows: number[][]): Mask {
  const m = matrixFromRows(rows);
  return { width: m.width, height: m.height, data: m.data };
}

export function toRows(m: { width: number; height: number; data: Uint8Array }): number[][] {
  const out: number[][] = [];
  for (let r = 0; r < m.height; r++) {
    out.push(Array.from(m.data.slice(r * m.width, (r + 1) * m.width)));
  }
  return out;
}

export function cloneMatrix(m: BinMatrix): BinMatrix {
  return { width: m.width, height: m.height, data: Uint8Array.from(m.data) };
}

export function inside(m: { width: number; height: number }, r: number, c: number): boolean {
  return r >= 0 && r < m.height && c >= 0 && c < m.width;
}

/** 掩膜外像元强制清零，返回新矩阵，原图不被改写。 */
export function applyMask(m: BinMatrix, mask: Mask): BinMatrix {
  if (m.width !== mask.width || m.height !== mask.height) {
    throw new Error('矩阵与掩膜尺寸不一致');
  }
  const out = cloneMatrix(m);
  for (let i = 0; i < out.data.length; i++) if (mask.data[i] === 0) out.data[i] = 0;
  return out;
}

export function sameSize(a: { width: number; height: number }, b: { width: number; height: number }): boolean {
  return a.width === b.width && a.height === b.height;
}
