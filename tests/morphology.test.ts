import { test } from "node:test";
import assert from "node:assert/strict";
import { dilate, erode, open, close, reflectSE } from "../src/morphology.ts";
import { matricesEqual, ones, zeros } from "../src/matrix.ts";
import { fullMaskLike } from "../src/morphology.ts";
import type { BinMatrix, StructuringElement } from "../src/types.ts";

const SE_CROSS: StructuringElement = {
  name: "cross",
  shape: [
    [0, 1, 0],
    [1, 1, 1],
    [0, 1, 0],
  ],
  anchor: [1, 1],
};

const SE_L: StructuringElement = {
  name: "L",
  shape: [
    [1, 0],
    [1, 1],
  ],
  anchor: [0, 0],
};

test("single pixel dilation is exactly the translated SE set", () => {
  const img = zeros(5, 5);
  img[2][2] = 1;
  const out = dilate(img, fullMaskLike(img), SE_CROSS, { border: "zero" });
  const expected = zeros(5, 5);
  expected[2][2] = 1;
  expected[1][2] = 1;
  expected[3][2] = 1;
  expected[2][1] = 1;
  expected[2][3] = 1;
  assert.ok(matricesEqual(out, expected));
});

test("erosion of translated copies requires full SE fit", () => {
  const img = zeros(5, 5);
  // Exactly one cross placement centred at (2,2) fits fully inside.
  img[2][2] = 1;
  img[1][2] = 1;
  img[3][2] = 1;
  img[2][1] = 1;
  img[2][3] = 1;
  const out = erode(img, fullMaskLike(img), SE_CROSS, { border: "zero" });
  const expected = zeros(5, 5);
  expected[2][2] = 1;
  assert.ok(matricesEqual(out, expected));
});

test("reflection rotates 180 degrees and moves the anchor", () => {
  const r = reflectSE(SE_L);
  assert.deepEqual(r.shape, [
    [1, 1],
    [0, 1],
  ]);
  assert.deepEqual(r.anchor, [1, 1]);
});

test("asymmetric SE with off-centre anchor produces the expected offset union", () => {
  // L with anchor at its top-left foreground cell: source pixel at (r,c)
  // contributes wherever the anchor lands, i.e. (r,c),(r-1,c),(r-1,c-1).
  const img = zeros(4, 4);
  img[1][1] = 1;
  const out = dilate(img, fullMaskLike(img), SE_L, { border: "zero" });
  const expected = zeros(4, 4);
  expected[1][1] = 1;
  expected[0][1] = 1;
  expected[0][0] = 1;
  assert.ok(matricesEqual(out, expected));
});

test("border=one lets erosion succeed at the canvas edge", () => {
  // Cross SE anchored at centre: corner erosion needs 2 external cells.
  const img: BinMatrix = [
    [1, 1],
    [1, 1],
  ];
  const out0 = erode(img, fullMaskLike(img), SE_CROSS, { border: "zero" });
  assert.equal(out0[0][0], 0); // external neighbours count as 0
  const out1 = erode(img, fullMaskLike(img), SE_CROSS, { border: "one" });
  assert.equal(out1[0][0], 1); // external neighbours count as 1
});

test("open and close are idempotent away from borders", () => {
  // Interior blob plus a two-pixel diagonal stalk; opening removes the tip.
  const img = zeros(11, 11);
  for (let r = 4; r <= 6; r++) for (let c = 4; c <= 6; c++) img[r][c] = 1;
  img[3][5] = 1;
  img[2][4] = 1; // tip pixel, unsupported under cross erosion
  const once = open(img, fullMaskLike(img), SE_CROSS, { border: "zero" });
  const twice = open(once, fullMaskLike(once), SE_CROSS, { border: "zero" });
  assert.ok(matricesEqual(once, twice));
  assert.equal(once[2][4], 0);

  const gapped = ones(11, 11);
  // Zero frame, then a one-cell notch in the middle of the block (away from frame).
  for (let i = 0; i < 11; i++) {
    gapped[0][i] = 0;
    gapped[10][i] = 0;
    gapped[i][0] = 0;
    gapped[i][10] = 0;
  }
  gapped[5][5] = 0;
  const c1 = close(gapped, fullMaskLike(gapped), SE_CROSS, { border: "zero" });
  const c2 = close(c1, fullMaskLike(c1), SE_CROSS, { border: "zero" });
  assert.ok(matricesEqual(c1, c2));
});

test("mask excludes gated pixels from set operations", () => {
  const img: BinMatrix = [
    [1, 1, 1],
    [1, 1, 1],
    [1, 1, 1],
  ];
  const mask: BinMatrix = [
    [1, 1, 0],
    [1, 1, 0],
    [0, 0, 0],
  ];
  const out = dilate(img, mask, SE_CROSS, { border: "one" });
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) if (mask[r][c] === 0) assert.equal(out[r][c], 0);
});
