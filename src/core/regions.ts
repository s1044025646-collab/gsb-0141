import { BinMatrix, Mask, idx } from './matrix.js';
import { Connectivity, backgroundConnectivity, labelComponents, LabelResult } from './labeling.js';

export interface PixelSize {
  /** 每个像元的物理高与宽（同单位），必须为正数；正方形时二者相等。 */
  pixelHeight: number;
  pixelWidth: number;
  unit?: string;
}

export interface BBox {
  minRow: number;
  maxRow: number;
  minCol: number;
  maxCol: number;
}

export interface Region {
  label: number;
  pixelCount: number;
  /** 物理面积 = 像元数 × pixelHeight × pixelWidth；与像元数量分开。 */
  area: number;
  centroidRow: number;
  centroidCol: number;
  centroidX: number;
  centroidY: number;
  bbox: BBox;
  /** 触边：该区域是否接触矩阵外框（图像边界）。 */
  touchesBorder: boolean;
  holeLabels: number[];
  holeCount: number;
  holePixelCount: number;
  /** 欧拉数（分量口径）= 1 - 该区域所含孔洞数。 */
  eulerNumber: number;
}

export interface Hole {
  holeLabel: number;
  pixelCount: number;
  area: number;
  bbox: BBox;
  /** 包围该孔洞的前景区域标签（可能多于一个）。 */
  surroundingLabels: number[];
  /** 孔洞内第一个像元，便于 CLI 定位 (row,col)。 */
  anchor: { row: number; col: number };
}

export interface MeasurementReport {
  width: number;
  height: number;
  connectivity: Connectivity;
  backgroundConnectivity: Connectivity;
  boundaryPolicy: string;
  pixelHeight: number;
  pixelWidth: number;
  unit: string | null;
  validPixelCount: number;
  validArea: number;
  foregroundPixelCount: number;
  foregroundArea: number;
  /** 前景占有效区域面积比例；掩膜外像元不计入分母。 */
  foregroundFraction: number;
  regionCount: number;
  totalHoleCount: number;
  /** 整幅前景欧拉数 = 前景分量数 - 孔洞数。全空时为 0。 */
  eulerNumber: number;
  regions: Region[];
  holes: Hole[];
}

export const MEASURE_BOUNDARY_POLICY =
  'outside-mask-and-image-border-as-exterior; morphology outside pixels as zero';

function bboxOf(pixels: number[], width: number): BBox {
  let minRow = Infinity;
  let maxRow = -Infinity;
  let minCol = Infinity;
  let maxCol = -Infinity;
  for (const p of pixels) {
    const r = Math.floor(p / width);
    const c = p % width;
    if (r < minRow) minRow = r;
    if (r > maxRow) maxRow = r;
    if (c < minCol) minCol = c;
    if (c > maxCol) maxCol = c;
  }
  return { minRow, maxRow, minCol, maxCol };
}

/**
 * 连通域测量。
 * - 前景使用 conn(4/8)，背景使用互补连通性；
 * - “外部背景”：接触图像外框，或 4-邻接掩膜外像元的背景分量；
 *   其余背景分量为孔洞。因此对角接触不封闭、触边背景不算孔洞；
 * - 孔洞分配给所有与其 4-邻接的前景区域标签。
 */
export function measure(
  m: BinMatrix,
  conn: Connectivity,
  ps: PixelSize,
  mask: Mask | null = null,
): MeasurementReport {
  if (!(ps.pixelHeight > 0) || !(ps.pixelWidth > 0) || !Number.isFinite(ps.pixelHeight) || !Number.isFinite(ps.pixelWidth)) {
    throw new Error('像元尺寸必须为正数');
  }
  const { width: w, height: h } = m;
  const cellArea = ps.pixelHeight * ps.pixelWidth;

  const fg: LabelResult = labelComponents(m, conn, mask, 1);
  const bgConn = backgroundConnectivity(conn);
  const bg: LabelResult = labelComponents(m, bgConn, mask, 0);

  let validPixelCount = 0;
  for (let i = 0; i < w * h; i++) if (!mask || mask.data[i] === 1) validPixelCount++;

  const exterior = new Set<number>();
  const dirs4: Array<[number, number]> = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  const dirs8: Array<[number, number]> = [
    [-1, -1], [-1, 0], [-1, 1],
    [0, -1], [0, 1],
    [1, -1], [1, 0], [1, 1],
  ];
  const bgDirs = bgConn === 8 ? dirs8 : dirs4;
  for (const pix of bg.pixels) {
    for (const i of pix) {
      const r = Math.floor(i / w);
      const c = i % w;
      let isExt = r === 0 || r === h - 1 || c === 0 || c === w - 1;
      if (!isExt && mask) {
        for (const [dr, dc] of bgDirs) {
          const j = idx(m, r + dr, c + dc);
          if (mask.data[j] === 0) {
            isExt = true;
            break;
          }
        }
      }
      if (isExt) {
        exterior.add(bg.labels[i]);
        break;
      }
    }
  }

  const holeByBgLabel = new Map<number, number>();
  const holes: Hole[] = [];
  bg.pixels.forEach((pix, idx0) => {
    const bgLab = idx0 + 1;
    if (exterior.has(bgLab)) return;
    const holeLabel = holes.length + 1;
    holeByBgLabel.set(bgLab, holeLabel);
    const p0 = pix[0];
    holes.push({
      holeLabel,
      pixelCount: pix.length,
      area: pix.length * cellArea,
      bbox: bboxOf(pix, w),
      surroundingLabels: [],
      anchor: { row: Math.floor(p0 / w), col: p0 % w },
    });
  });

  const holeLabelsOfRegion = new Map<number, Set<number>>();
  const holePixelOfRegion = new Map<number, number>();
  for (const pix of fg.pixels) {
    const lab = fg.labels[pix[0]];
    for (const i of pix) {
      const r = Math.floor(i / w);
      const c = i % w;
      for (const [dr, dc] of dirs4) {
        const rr = r + dr;
        const cc = c + dc;
        if (rr < 0 || rr >= h || cc < 0 || cc >= w) continue;
        const j = idx(m, rr, cc);
        if (mask && mask.data[j] === 0) continue;
        if (m.data[j] !== 0) continue;
        const hl = holeByBgLabel.get(bg.labels[j]);
        if (hl === undefined) continue;
        let set = holeLabelsOfRegion.get(lab);
        if (!set) {
          set = new Set();
          holeLabelsOfRegion.set(lab, set);
          holePixelOfRegion.set(lab, 0);
        }
        if (!set.has(hl)) {
          set.add(hl);
          holePixelOfRegion.set(lab, (holePixelOfRegion.get(lab) ?? 0) + holes[hl - 1].pixelCount);
        }
      }
    }
  }

  const regions: Region[] = fg.pixels.map((pix, idx0) => {
    const lab = idx0 + 1;
    const bb = bboxOf(pix, w);
    let sr = 0;
    let sc = 0;
    let border = false;
    for (const i of pix) {
      const r = Math.floor(i / w);
      const c = i % w;
      sr += r + 0.5;
      sc += c + 0.5;
      if (r === 0 || r === h - 1 || c === 0 || c === w - 1) border = true;
    }
    const n = pix.length;
    const hlSet = holeLabelsOfRegion.get(lab);
    const holeLabels = hlSet ? Array.from(hlSet).sort((a, b) => a - b) : [];
    return {
      label: lab,
      pixelCount: n,
      area: n * cellArea,
      centroidRow: sr / n,
      centroidCol: sc / n,
      centroidX: (sc / n) * ps.pixelWidth,
      centroidY: (sr / n) * ps.pixelHeight,
      bbox: bb,
      touchesBorder: border,
      holeLabels,
      holeCount: holeLabels.length,
      holePixelCount: holePixelOfRegion.get(lab) ?? 0,
      eulerNumber: 1 - holeLabels.length,
    };
  });

  for (const hole of holes) {
    const s = new Set<number>();
    for (const i of bg.pixels[hole.holeLabel - 1]) {
      const r = Math.floor(i / w);
      const c = i % w;
      for (const [dr, dc] of dirs4) {
        const rr = r + dr;
        const cc = c + dc;
        if (rr < 0 || rr >= h || cc < 0 || cc >= w) continue;
        const j = idx(m, rr, cc);
        if (mask && mask.data[j] === 0) continue;
        if (m.data[j] === 1) s.add(fg.labels[j]);
      }
    }
    hole.surroundingLabels = Array.from(s).sort((a, b) => a - b);
  }

  let fgCount = 0;
  for (let i = 0; i < m.data.length; i++) {
    if ((!mask || mask.data[i] === 1) && m.data[i] === 1) fgCount++;
  }

  return {
    width: w,
    height: h,
    connectivity: conn,
    backgroundConnectivity: bgConn,
    boundaryPolicy: MEASURE_BOUNDARY_POLICY,
    pixelHeight: ps.pixelHeight,
    pixelWidth: ps.pixelWidth,
    unit: ps.unit ?? null,
    validPixelCount,
    validArea: validPixelCount * cellArea,
    foregroundPixelCount: fgCount,
    foregroundArea: fgCount * cellArea,
    foregroundFraction: validPixelCount === 0 ? 0 : fgCount / validPixelCount,
    regionCount: regions.length,
    totalHoleCount: holes.length,
    eulerNumber: fgCount === 0 ? 0 : regions.length - holes.length,
    regions,
    holes,
  };
}
