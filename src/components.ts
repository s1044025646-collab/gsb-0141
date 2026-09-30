import type {
  BinMatrix,
  BorderMode,
  Connectivity,
  HoleInfo,
  LabelReport,
  PixelSize,
  RegionStats,
} from "./types.ts";
import { dimsOf } from "./matrix.ts";

const N4: Array<[number, number]> = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];
const N8: Array<[number, number]> = [
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, -1],
  [0, 1],
  [1, -1],
  [1, 0],
  [1, 1],
];

/**
 * Foreground connectivity k (4 or 8); background uses the complementary one.
 * Complementary means 4-foreground <-> 8-background and vice versa, which is
 * the pair for which the planar Euler relation holes = components - euler
 * holds without paradoxes (diagonal-only foreground contact is a connection
 * exactly when diagonal-only background contact is not).
 */
export function complementary(k: Connectivity): Connectivity {
  return k === 4 ? 8 : 4;
}

interface LabelResult {
  labels: number[][];
  count: number;
  /** label -> touches the border of the valid region */
  touches: Map<number, boolean>;
}

function labelComponents(
  domain: BinMatrix,
  mask: BinMatrix,
  value: 0 | 1,
  conn: Connectivity,
  height: number,
  width: number,
): LabelResult {
  const labels: number[][] = Array.from({ length: height }, () => new Array<number>(width).fill(0));
  const touches = new Map<number, boolean>();
  const neigh = conn === 4 ? N4 : N8;
  let next = 0;
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      if (mask[r][c] === 0 || domain[r][c] !== value || labels[r][c] !== 0) continue;
      next++;
      const lbl = next;
      labels[r][c] = lbl;
      touches.set(lbl, false);
      const queue: Array<[number, number]> = [[r, c]];
      while (queue.length > 0) {
        const [cr, cc] = queue.pop()!;
        if (cr === 0 || cc === 0 || cr === height - 1 || cc === width - 1) {
          touches.set(lbl, true);
        }
        for (const [dr, dc] of neigh) {
          const nr = cr + dr;
          const nc = cc + dc;
          if (nr < 0 || nc < 0 || nr >= height || nc >= width) continue;
          if (mask[nr][nc] === 0 || labels[nr][nc] !== 0 || domain[nr][nc] !== value) continue;
          labels[nr][nc] = lbl;
          queue.push([nr, nc]);
        }
      }
    }
  }
  return { labels, count: next, touches };
}

/**
 * Label foreground and background and compute measurements.
 *
 * Border semantics for labeling: the canvas border is the valid-mask border.
 * A background component touching that border is the exterior (never a hole).
 * A background pocket fully enclosed by foreground is a hole of exactly one
 * foreground component: using complementary connectivity, every non-exterior
 * background component is adjacent (under the opposite connectivity) to a
 * single foreground component; that component owns the hole.
 */
export function labelAndMeasure(
  img: BinMatrix,
  mask: BinMatrix,
  pixelSize: PixelSize,
  connectivity: Connectivity,
  border: BorderMode,
): LabelReport {
  const { width, height } = dimsOf(img);
  const fg = labelComponents(img, mask, 1, connectivity, height, width);
  const bgConn = complementary(connectivity);
  const bg = labelComponents(img, mask, 0, bgConn, height, width);

  const pxArea = pixelSize.x * pixelSize.y;
  const regions: RegionStats[] = [];
  const sums = new Map<
    number,
    { n: number; sr: number; sc: number; minR: number; maxR: number; minC: number; maxC: number }
  >();
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const l = fg.labels[r][c];
      if (l === 0) continue;
      let s = sums.get(l);
      if (!s) {
        s = { n: 0, sr: 0, sc: 0, minR: r, maxR: r, minC: c, maxC: c };
        sums.set(l, s);
      }
      s.n++;
      s.sr += r;
      s.sc += c;
      if (r < s.minR) s.minR = r;
      if (r > s.maxR) s.maxR = r;
      if (c < s.minC) s.minC = c;
      if (c > s.maxC) s.maxC = c;
    }
  }

  const fgNeigh = connectivity === 4 ? N4 : N8;
  // Background label -> owning foreground label (unique under complementarity).
  const owner = new Map<number, number>();
  const holeSeeds = new Map<number, [number, number]>();
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const bl = bg.labels[r][c];
      if (bl === 0 || bg.touches.get(bl) || owner.has(bl)) continue;
      for (const [dr, dc] of fgNeigh) {
        const nr = r + dr;
        const nc = c + dc;
        if (nr < 0 || nc < 0 || nr >= height || nc >= width) continue;
        const fl = fg.labels[nr][nc];
        if (fl !== 0) {
          owner.set(bl, fl);
          // Scanned in raster order, so this is the top-left-most pocket cell.
          holeSeeds.set(bl, [r, c]);
          break;
        }
      }
    }
  }

  const holeCounts = new Map<number, number>();
  const holes: HoleInfo[] = [];
  const bboxByBg = new Map<number, { n: number; minR: number; maxR: number; minC: number; maxC: number }>();
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const bl = bg.labels[r][c];
      if (bl === 0 || bg.touches.get(bl) || !owner.has(bl)) continue;
      let b = bboxByBg.get(bl);
      if (!b) {
        b = { n: 0, minR: r, maxR: r, minC: c, maxC: c };
        bboxByBg.set(bl, b);
      }
      b.n++;
      if (r < b.minR) b.minR = r;
      if (r > b.maxR) b.maxR = r;
      if (c < b.minC) b.minC = c;
      if (c > b.maxC) b.maxC = c;
    }
  }

  const ownerSorted = [...owner.entries()].sort((a, b) => a[0] - b[0]);
  for (const [bl, fl] of ownerSorted) {
    holeCounts.set(fl, (holeCounts.get(fl) ?? 0) + 1);
    const b = bboxByBg.get(bl)!;
    holes.push({
      id: `${fl}-${bl}`,
      regionLabel: fl,
      backgroundLabel: bl,
      pixelCount: b.n,
      area: b.n * pxArea,
      seed: holeSeeds.get(bl)!,
      bbox: { minRow: b.minR, maxRow: b.maxR, minCol: b.minC, maxCol: b.maxC },
      touchesBorder: false,
    });
  }

  let totalFg = 0;
  for (const l of [...sums.keys()].sort((a, b) => a - b)) {
    const s = sums.get(l)!;
    totalFg += s.n;
    const h = holeCounts.get(l) ?? 0;
    regions.push({
      label: l,
      pixelCount: s.n,
      area: s.n * pxArea,
      centroid: {
        row: s.sr / s.n,
        col: s.sc / s.n,
        rowPhysical: (s.sr / s.n + 0.5) * pixelSize.y,
        colPhysical: (s.sc / s.n + 0.5) * pixelSize.x,
      },
      bbox: { minRow: s.minR, maxRow: s.maxR, minCol: s.minC, maxCol: s.maxC },
      holes: h,
      euler: 1 - h,
      touchesBorder: fg.touches.get(l) ?? false,
    });
  }

  return {
    connectivity,
    border,
    labels: fg.labels,
    regions,
    holes,
    pixelCount: totalFg,
    physicalAreaUnit: `${pixelSize.unit ?? "px"}^2`,
  };
}
