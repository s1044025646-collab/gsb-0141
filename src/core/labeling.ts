import { BinMatrix, Mask, idx, makeMatrix, sameSize } from './matrix.js';

export type Connectivity = 4 | 8;

/** 互补连通性：前景 8 连通时背景 4 连通，反之亦然。 */
export function backgroundConnectivity(fg: Connectivity): Connectivity {
  return fg === 8 ? 4 : 8;
}

class DSU {
  parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    let root = x;
    while (this.parent[root] !== root) root = this.parent[root];
    while (this.parent[x] !== x) {
      const next = this.parent[x];
      this.parent[x] = root;
      x = next;
    }
    return root;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) {
      // 编号确定性：保留较小根
      if (ra < rb) this.parent[rb] = ra;
      else this.parent[ra] = rb;
    }
  }
}

/** 邻居偏移；扫描时只看“过去”的邻居（上方、左上、右上、左侧）即可完成两遍标记。 */
function neighbors(conn: Connectivity, pass: 'scan'): Array<[number, number]> {
  void pass;
  return conn === 8
    ? [[-1, -1], [-1, 0], [-1, 1], [0, -1]]
    : [[-1, 0], [0, -1]];
}

export interface LabelResult {
  /** 标签矩阵，0 表示背景/掩膜外；标签按首次出现（行优先）从 1 编号。 */
  labels: Uint32Array;
  width: number;
  height: number;
  count: number;
  /** 每个标签包含的像元线性索引 */
  pixels: number[][];
}

/** 两遍扫描连通域标记；value=1 标记前景，value=0 标记有效区域内背景。掩膜外像元跳过。 */
export function labelComponents(
  m: BinMatrix,
  conn: Connectivity,
  mask: Mask | null = null,
  value: 0 | 1 = 1,
): LabelResult {
  if (mask && !sameSize(m, mask)) throw new Error('矩阵与掩膜尺寸不一致');
  const { width: w, height: h } = m;
  const labels = new Uint32Array(w * h);
  const dsu = new DSU(w * h + 1);
  let next = 1;
  const nbrs = neighbors(conn, 'scan');

  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const i = idx(m, r, c);
      if (mask && mask.data[i] === 0) continue;
      if (m.data[i] !== value) continue;
      let minLabel = 0;
      for (const [dr, dc] of nbrs) {
        const rr = r + dr;
        const cc = c + dc;
        if (rr < 0 || rr >= h || cc < 0 || cc >= w) continue;
        const j = idx(m, rr, cc);
        if (mask && mask.data[j] === 0) continue;
        if (m.data[j] !== value) continue;
        const lab = labels[j];
        if (lab === 0) continue;
        if (minLabel === 0) minLabel = dsu.find(lab);
        else dsu.union(minLabel, lab);
      }
      if (minLabel === 0) {
        labels[i] = next++;
      } else {
        labels[i] = dsu.find(minLabel);
      }
    }
  }

  // 第二遍：归一化根，按行优先首次出现顺序压缩为 1..N
  const remap = new Map<number, number>();
  let count = 0;
  const pixels: number[][] = [];
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] === 0) continue;
    const root = dsu.find(labels[i]);
    let newLab = remap.get(root);
    if (newLab === undefined) {
      newLab = ++count;
      remap.set(root, newLab);
      pixels.push([]);
    }
    labels[i] = newLab;
    pixels[newLab - 1].push(i);
  }
  return { labels, width: w, height: h, count, pixels };
}

/** 与 makeMatrix 尺寸一致的标签矩阵副本（便于导出）。 */
export function labelsToRows(res: LabelResult): number[][] {
  const rows: number[][] = [];
  for (let r = 0; r < res.height; r++) {
    rows.push(Array.from(res.labels.slice(r * res.width, (r + 1) * res.width)));
  }
  return rows;
}

export function emptyLabelMatrix(width: number, height: number): BinMatrix {
  return makeMatrix(width, height);
}
