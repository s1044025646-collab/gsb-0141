import type { BinMatrix, PixelSize, VersionPayload } from "./types.ts";

export class ValidationError extends Error {
  code = "VALIDATION_ERROR";
}

export interface Dimensions {
  width: number;
  height: number;
}

export function dimsOf(data: BinMatrix): Dimensions {
  if (!Array.isArray(data) || data.length === 0) {
    throw new ValidationError("matrix must be a non-empty array of rows");
  }
  const height = data.length;
  const width = data[0].length;
  if (width === 0) throw new ValidationError("matrix rows must be non-empty");
  for (const row of data) {
    if (!Array.isArray(row) || row.length !== width) {
      throw new ValidationError("matrix rows must all have the same width");
    }
    for (const v of row) {
      if (v !== 0 && v !== 1) throw new ValidationError("matrix values must be 0 or 1");
    }
  }
  return { width, height };
}

export function validatePixelSize(p: PixelSize): PixelSize {
  if (typeof p !== "object" || p === null) throw new ValidationError("pixelSize required");
  if (!Number.isFinite(p.x) || p.x <= 0 || !Number.isFinite(p.y) || p.y <= 0) {
    throw new ValidationError("pixelSize.x and pixelSize.y must be positive finite numbers");
  }
  return { x: p.x, y: p.y, unit: p.unit === undefined ? "px" : String(p.unit) };
}

export function validatePayload(payload: VersionPayload): VersionPayload {
  const d = dimsOf(payload.data);
  const m = dimsOf(payload.mask);
  if (m.width !== d.width || m.height !== d.height) {
    throw new ValidationError("mask dimensions must match data dimensions");
  }
  return {
    width: d.width,
    height: d.height,
    data: cloneMatrix(payload.data),
    mask: cloneMatrix(payload.mask),
    pixelSize: validatePixelSize(payload.pixelSize),
  };
}

export function cloneMatrix(m: BinMatrix): BinMatrix {
  return m.map((row) => row.slice());
}

export function zeros(height: number, width: number): BinMatrix {
  return Array.from({ length: height }, () => new Array<number>(width).fill(0));
}

export function ones(height: number, width: number): BinMatrix {
  return Array.from({ length: height }, () => new Array<number>(width).fill(1));
}

/**
 * Pack a binary matrix into a base64 string, MSB-first within each byte.
 * Row boundaries are implicit via width/height stored separately.
 */
export function encodeMatrix(m: BinMatrix): string {
  const { width, height } = dimsOf(m);
  const total = width * height;
  const bytes = new Uint8Array(Math.ceil(total / 8));
  let idx = 0;
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      if (m[r][c] === 1) bytes[idx >> 3] |= 1 << (7 - (idx & 7));
      idx++;
    }
  }
  return Buffer.from(bytes).toString("base64");
}

export function decodeMatrix(encoded: string, height: number, width: number): BinMatrix {
  const bytes = Buffer.from(encoded, "base64");
  const m = zeros(height, width);
  let idx = 0;
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      m[r][c] = (bytes[idx >> 3] >> (7 - (idx & 7))) & 1;
      idx++;
    }
  }
  return m;
}

export function matricesEqual(a: BinMatrix, b: BinMatrix): boolean {
  if (a.length !== b.length) return false;
  for (let r = 0; r < a.length; r++) {
    if (a[r].length !== b[r].length) return false;
    for (let c = 0; c < a[r].length; c++) if (a[r][c] !== b[r][c]) return false;
  }
  return true;
}

/** Count foreground pixels only inside the valid mask. */
export function countForeground(m: BinMatrix, mask: BinMatrix): number {
  let n = 0;
  for (let r = 0; r < m.length; r++) {
    for (let c = 0; c < m[r].length; c++) if (mask[r][c] === 1 && m[r][c] === 1) n++;
  }
  return n;
}
