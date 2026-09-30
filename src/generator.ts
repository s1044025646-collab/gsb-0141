import type { BinMatrix, PixelSize, VersionPayload } from "./types.ts";
import { ones, zeros } from "./matrix.ts";

/**
 * Deterministic PRNG (mulberry32). Tests inject a seed so output is repeatable.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface GenerateOptions {
  width: number;
  height: number;
  /** Foreground probability 0..1. */
  density?: number;
  seed?: number;
  pixelSize?: PixelSize;
  /** When true every cell is valid; otherwise an inset border is invalid. */
  fullMask?: boolean;
  maskInset?: number;
}

/** Generate a random binary matrix plus its valid-region mask. */
export function generateMatrix(opts: GenerateOptions): VersionPayload {
  const { width, height } = opts;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error("width/height must be positive integers");
  }
  const density = opts.density ?? 0.5;
  if (density < 0 || density > 1) throw new Error("density must be within [0,1]");
  const rand = mulberry32(opts.seed ?? 1);
  const data: BinMatrix = zeros(height, width);
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) data[r][c] = rand() < density ? 1 : 0;
  }
  const inset = opts.maskInset ?? 0;
  const mask: BinMatrix = opts.fullMask === false || inset > 0 ? zeros(height, width) : ones(height, width);
  if (inset > 0) {
    for (let r = inset; r < height - inset; r++) {
      for (let c = inset; c < width - inset; c++) mask[r][c] = 1;
    }
  }
  return {
    width,
    height,
    data,
    mask,
    pixelSize: opts.pixelSize ?? { x: 1, y: 1, unit: "px" },
  };
}

/** Build a filled ring (rectangular annulus): useful fixed test fixture. */
export function ringMatrix(outer: number, thickness = 1): BinMatrix {
  const m = ones(outer, outer);
  for (let r = thickness; r < outer - thickness; r++) {
    for (let c = thickness; c < outer - thickness; c++) m[r][c] = 0;
  }
  return m;
}
