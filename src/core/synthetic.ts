import { BinMatrix, makeMatrix, Mask, idx } from './matrix.js';

/**
 * 合成像素矩阵生成器（确定性，无随机性；随机场景由调用方注入种子 RNG）。
 */

export type Rng = () => number;

/** mulberry32：可注入、可复现的伪随机数生成器。 */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function empty(width: number, height: number): BinMatrix {
  return makeMatrix(width, height);
}

export function filled(width: number, height: number): BinMatrix {
  const m = makeMatrix(width, height);
  m.data.fill(1);
  return m;
}

/** 实心矩形（含边界坐标）。 */
export function rect(width: number, height: number, r0: number, c0: number, r1: number, c1: number): BinMatrix {
  const m = makeMatrix(width, height);
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      if (r >= 0 && r < height && c >= 0 && c < width) m.data[idx(m, r, c)] = 1;
    }
  }
  return m;
}

/** 1 像元厚的矩形环（制造孔洞的夹具）。 */
export function ring(width: number, height: number, r0: number, c0: number, r1: number, c1: number): BinMatrix {
  const m = makeMatrix(width, height);
  for (let c = c0; c <= c1; c++) {
    if (c >= 0 && c < width) {
      if (r0 >= 0 && r0 < height) m.data[idx(m, r0, c)] = 1;
      if (r1 >= 0 && r1 < height) m.data[idx(m, r1, c)] = 1;
    }
  }
  for (let r = r0; r <= r1; r++) {
    if (r >= 0 && r < height) {
      if (c0 >= 0 && c0 < width) m.data[idx(m, r, c0)] = 1;
      if (c1 >= 0 && c1 < width) m.data[idx(m, r, c1)] = 1;
    }
  }
  return m;
}

/** 对角相连线段：(r0,c0),(r0+dr,c0+dc)... 步长 ±1。 */
export function diagonal(width: number, height: number, r0: number, c0: number, length: number, dr: 1 | -1, dc: 1 | -1): BinMatrix {
  const m = makeMatrix(width, height);
  for (let k = 0; k < length; k++) {
    const r = r0 + k * dr;
    const c = c0 + k * dc;
    if (r >= 0 && r < height && c >= 0 && c < width) m.data[idx(m, r, c)] = 1;
  }
  return m;
}

/** 盐噪：以概率 p 将有效像元置 1，由注入 RNG 决定，可复现。 */
export function saltNoise(width: number, height: number, p: number, rng: Rng, mask: Mask | null = null): BinMatrix {
  const m = makeMatrix(width, height);
  for (let i = 0; i < m.data.length; i++) {
    if (mask && mask.data[i] === 0) continue;
    m.data[i] = rng() < p ? 1 : 0;
  }
  return m;
}

/** 矩形有效区域掩膜；掩膜外为 0。 */
export function rectMask(width: number, height: number, r0: number, c0: number, r1: number, c1: number): Mask {
  const m = makeMatrix(width, height);
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      if (r >= 0 && r < height && c >= 0 && c < width) m.data[idx(m, r, c)] = 1;
    }
  }
  return m;
}
