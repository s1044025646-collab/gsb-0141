import type { BinMatrix, BorderMode, StructuringElement } from "./types.ts";
import { cloneMatrix, dimsOf, ones, ValidationError, zeros } from "./matrix.ts";

/**
 * Morphology rules (documented and enforced):
 *
 * A structuring element B is a set of foreground offsets relative to its anchor
 * (ar, ac): for each shape cell equal to 1 at (sr, sc) the offset is
 * (sr - ar, sc - ac). Elements may be asymmetric; the anchor need not be the
 * centre or even a foreground cell.
 *
 * Reflection (B^): rotate the shape 180 degrees AND move the anchor to the
 * reflected position (h-1-ar, w-1-ac). Erosion is computed directly with B
 * (equivalently dilation by B^), never as a neighbour count.
 *
 * Dilation (set Minkowski sum, computed directly):
 *   (A ⊕ B)[p] = 1 iff ∃ b ∈ B : A[p + b] = 1
 * Erosion (set Minkowski erosion, computed directly):
 *   (A ⊖ B)[p] = 1 iff ∀ b ∈ B : A[p + b] = 1
 * Opening = erode then dilate with the same B; closing = dilate then erode.
 *
 * Image-external values (p + b falls outside the canvas):
 *   "zero"   -> outside is background 0 (default; dilation loses border hits,
 *               erosion cannot succeed at the border)
 *   "one"    -> outside is foreground 1
 *   "mirror" -> the value is read from the coordinate reflected at the border
 * The valid-region mask is applied last as a hard gate: outputs at mask=0 are
 * always 0 and are never part of any area denominator.
 */

export function normalizeSE(se: StructuringElement): Required<StructuringElement> {
  const d = dimsOf(se.shape);
  const anchor: [number, number] =
    se.anchor ?? [Math.floor((d.height - 1) / 2), Math.floor((d.width - 1) / 2)];
  if (!Array.isArray(anchor) || anchor.length !== 2) {
    throw new ValidationError("SE anchor must be [row, col]");
  }
  const [ar, ac] = anchor;
  if (!Number.isInteger(ar) || !Number.isInteger(ac) || ar < 0 || ar >= d.height || ac < 0 || ac >= d.width) {
    throw new ValidationError("SE anchor must be an in-bounds integer cell of its shape");
  }
  if (typeof se.name !== "string" || se.name.length === 0) {
    throw new ValidationError("SE needs a non-empty name");
  }
  return { name: se.name, shape: cloneMatrix(se.shape), anchor: [ar, ac] };
}

/** B^ : 180-degree rotation with the anchor reflected to the matching cell. */
export function reflectSE(se: StructuringElement): Required<StructuringElement> {
  const n = normalizeSE(se);
  const { width, height } = dimsOf(n.shape);
  const r = zeros(height, width);
  for (let i = 0; i < height; i++) {
    for (let j = 0; j < width; j++) r[height - 1 - i][width - 1 - j] = n.shape[i][j];
  }
  return {
    name: `${n.name}^`,
    shape: r,
    anchor: [height - 1 - n.anchor[0], width - 1 - n.anchor[1]],
  };
}

function offsetsOf(se: Required<StructuringElement>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const [ar, ac] = se.anchor;
  for (let i = 0; i < se.shape.length; i++) {
    for (let j = 0; j < se.shape[i].length; j++) {
      if (se.shape[i][j] === 1) out.push([i - ar, j - ac]);
    }
  }
  if (out.length === 0) throw new ValidationError("structuring element has no foreground cells");
  return out;
}

function externalValueGetter(img: BinMatrix, border: BorderMode) {
  const h = img.length;
  const w = img[0].length;
  if (border === "one") {
    return (r: number, c: number): number =>
      r < 0 || c < 0 || r >= h || c >= w ? 1 : img[r][c];
  }
  if (border === "mirror") {
    return (r: number, c: number): number =>
      img[Math.min(h - 1, Math.max(0, r))][Math.min(w - 1, Math.max(0, c))];
  }
  return (r: number, c: number): number =>
    r < 0 || c < 0 || r >= h || c >= w ? 0 : img[r][c];
}

export interface MorphOptions {
  border?: BorderMode;
}

function applySE(
  img: BinMatrix,
  mask: BinMatrix,
  rawSE: StructuringElement,
  mode: "dilate" | "erode",
  opts: MorphOptions = {},
): BinMatrix {
  const border: BorderMode = opts.border ?? "zero";
  const se = normalizeSE(rawSE);
  const offsets = mode === "dilate" ? offsetsOf(se) : offsetsOf(se);
  const { width, height } = dimsOf(img);
  const get = externalValueGetter(img, border);
  const out = zeros(height, width);
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      if (mask[r][c] === 0) continue; // mask gate: outside the valid region stays 0
      let v = mode === "dilate" ? 0 : 1;
      for (const [dr, dc] of offsets) {
        const x = get(r + dr, c + dc);
        if (mode === "dilate") {
          if (x === 1) {
            v = 1;
            break;
          }
        } else if (x === 0) {
          v = 0;
          break;
        }
      }
      out[r][c] = v;
    }
  }
  return out;
}

export function dilate(
  img: BinMatrix,
  mask: BinMatrix,
  se: StructuringElement,
  opts: MorphOptions = {},
): BinMatrix {
  return applySE(img, mask, se, "dilate", opts);
}

export function erode(
  img: BinMatrix,
  mask: BinMatrix,
  se: StructuringElement,
  opts: MorphOptions = {},
): BinMatrix {
  return applySE(img, mask, se, "erode", opts);
}

export function open(
  img: BinMatrix,
  mask: BinMatrix,
  se: StructuringElement,
  opts: MorphOptions = {},
): BinMatrix {
  return dilate(erode(img, mask, se, opts), mask, se, opts);
}

export function close(
  img: BinMatrix,
  mask: BinMatrix,
  se: StructuringElement,
  opts: MorphOptions = {},
): BinMatrix {
  return erode(dilate(img, mask, se, opts), mask, se, opts);
}

export function fullMaskLike(img: BinMatrix): BinMatrix {
  const { width, height } = dimsOf(img);
  return ones(height, width);
}
