import { BinMatrix, Mask, idx, inside, makeMatrix, sameSize } from './matrix.js';

/**
 * 结构元素（Structuring Element）。
 * shape: 与图像坐标系相同的行/列网格，1 表示集合 B 的成员；允许非对称形状。
 * anchor: 锚点 (anchorRow, anchorCol)，必须落在 shape 内；
 *         参与运算的位移为 (dr,dc) = (r-anchorRow, c-anchorCol)。
 *
 * 反射规则：B 关于锚点的反射为 B^ = { (-dr,-dc) : (dr,dc)∈B-offsets }。
 *   本实现一律使用“锚点位移 + 直接集合定义”：
 *     膨胀  (A⊕B)[p] = OR  { A[p - t] : t∈B̂ }        （B̂ 为反射后的位移集合）
 *     腐蚀  (A⊖B)[p] = AND { A[p + t] : t∈B̂ }
 *   即膨胀平移原图 +t 后取并集，腐蚀要求 B̂ 全部包含于 A。
 *
 * 图像外部取值：边界外一律按 0（背景）处理（zero-padding）。
 *   这是显式的边界策略并会写入处理报告；因此靠近边界的腐蚀会收缩、
 *   膨胀不会把前景写到掩膜外（掩膜外结果恒为 0）。
 */
export interface StructElement {
  name: string;
  shape: number[][];
  anchorRow: number;
  anchorCol: number;
}

export interface SeOffsets {
  /** 反射后的位移集合 B̂：膨胀平移量 / 腐蚀探测偏移 */
  reflected: Array<[number, number]>;
  /** 原始位移集合（锚点相对坐标） */
  raw: Array<[number, number]>;
}

export const BOUNDARY_POLICY = 'outside-as-zero';

export function validateSe(se: StructElement): void {
  if (!se.name || typeof se.name !== 'string') throw new Error('结构元素缺少 name');
  if (!Array.isArray(se.shape) || se.shape.length === 0 || !Array.isArray(se.shape[0])) {
    throw new Error('结构元素 shape 必须为非空二维数组');
  }
  const h = se.shape.length;
  const w = se.shape[0].length;
  let members = 0;
  for (let r = 0; r < h; r++) {
    if (!Array.isArray(se.shape[r]) || se.shape[r].length !== w) {
      throw new Error('结构元素行列长度不一致');
    }
    for (let c = 0; c < w; c++) {
      const v = se.shape[r][c];
      if (v !== 0 && v !== 1) throw new Error('结构元素只允许 0/1');
      if (v === 1) members++;
    }
  }
  if (members === 0) throw new Error('结构元素不能为空集合');
  if (!Number.isInteger(se.anchorRow) || !Number.isInteger(se.anchorCol)) {
    throw new Error('锚点必须为整数');
  }
  if (se.anchorRow < 0 || se.anchorRow >= h || se.anchorCol < 0 || se.anchorCol >= w) {
    throw new Error('锚点必须落在结构元素内部');
  }
}

export function seOffsets(se: StructElement): SeOffsets {
  validateSe(se);
  const raw: Array<[number, number]> = [];
  for (let r = 0; r < se.shape.length; r++) {
    for (let c = 0; c < se.shape[r].length; c++) {
      if (se.shape[r][c] === 1) {
        // 归一化 -0 为 0
        const dr = r - se.anchorRow;
        const dc = c - se.anchorCol;
        raw.push([dr === 0 ? 0 : dr, dc === 0 ? 0 : dc]);
      }
    }
  }
  return {
    raw,
    reflected: raw.map(([dr, dc]) => [(dr === 0 ? 0 : -dr), (dc === 0 ? 0 : -dc)] as [number, number]),
  };
}

function prepare(src: BinMatrix, mask: Mask | null): BinMatrix {
  const m = mask ?? { width: src.width, height: src.height, data: new Uint8Array(src.data.length).fill(1) };
  if (!sameSize(src, m)) throw new Error('矩阵与掩膜尺寸不一致');
  const out = makeMatrix(src.width, src.height);
  for (let i = 0; i < out.data.length; i++) out.data[i] = mask ? (m.data[i] && src.data[i]) : src.data[i];
  return out;
}

/** 膨胀 A⊕B：对每个前景像元 p，将 p+t (t∈B̂) 写入结果（平移并集，非邻域计数）。 */
export function dilate(src: BinMatrix, se: StructElement, mask: Mask | null = null): BinMatrix {
  const a = prepare(src, mask);
  const { raw } = seOffsets(se);
  const out = makeMatrix(a.width, a.height);
  for (let r = 0; r < a.height; r++) {
    for (let c = 0; c < a.width; c++) {
      if (a.data[idx(a, r, c)] !== 1) continue;
      // 集合定义：A⊕B = ⋃_{b∈B} A_b，即把原图平移每个 B 成员位移后取并集
      for (const [dr, dc] of raw) {
        const rr = r + dr;
        const cc = c + dc;
        // 图像外按 0（不写入）；掩膜外目标同样保持 0
        if (inside(a, rr, cc) && (!mask || mask.data[idx(a, rr, cc)] === 1)) {
          out.data[idx(out, rr, cc)] = 1;
        }
      }
    }
  }
  return out;
}

/** 腐蚀 A⊖B：当 B̂ 平移到 p 后全部落在前景（边界外按 0）时 p 为前景。 */
export function erode(src: BinMatrix, se: StructElement, mask: Mask | null = null): BinMatrix {
  const a = prepare(src, mask);
  const { raw } = seOffsets(se);
  const out = makeMatrix(a.width, a.height);
  for (let r = 0; r < a.height; r++) {
    for (let c = 0; c < a.width; c++) {
      let fit = true;
      // 集合定义：A⊖B = { p : B 平移到 p 后是 A 的子集 }，即所有 p+b 都是前景
      for (const [dr, dc] of raw) {
        const rr = r + dr;
        const cc = c + dc;
        // 越界 => 外部按 0；掩膜外同样为 0
        if (!inside(a, rr, cc) || a.data[idx(a, rr, cc)] !== 1) {
          fit = false;
          break;
        }
      }
      if (fit) out.data[idx(out, r, c)] = 1;
    }
  }
  return out;
}

/** 开运算 A∘B = (A⊖B)⊕B，同一结构元素与锚点。 */
export function opening(src: BinMatrix, se: StructElement, mask: Mask | null = null): BinMatrix {
  return dilate(erode(src, se, mask), se, mask);
}

/** 闭运算 A•B = (A⊕B)⊖B，同一结构元素与锚点。 */
export function closing(src: BinMatrix, se: StructElement, mask: Mask | null = null): BinMatrix {
  return erode(dilate(src, se, mask), se, mask);
}

export type MorphOp = 'dilate' | 'erode' | 'open' | 'close';

export function applyMorph(op: MorphOp, src: BinMatrix, se: StructElement, mask: Mask | null = null): BinMatrix {
  switch (op) {
    case 'dilate': return dilate(src, se, mask);
    case 'erode': return erode(src, se, mask);
    case 'open': return opening(src, se, mask);
    case 'close': return closing(src, se, mask);
    default: throw new Error(`未知形态学操作: ${String(op)}`);
  }
}
