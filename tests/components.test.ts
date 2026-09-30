import { test } from "node:test";
import assert from "node:assert/strict";
import { labelAndMeasure } from "../src/components.ts";
import { ones } from "../src/matrix.ts";
import type { BinMatrix } from "../src/types.ts";

const PX = { x: 2, y: 3, unit: "um" };

function run(data: BinMatrix, conn: 4 | 8 = 4, mask?: BinMatrix) {
  return labelAndMeasure(data, mask ?? ones(data.length, data[0].length), PX, conn, "zero");
}

test("single pixel: one region, zero holes, physical area differs from pixel count", () => {
  const rep = run([[1]]);
  assert.equal(rep.regions.length, 1);
  const r = rep.regions[0];
  assert.equal(r.pixelCount, 1);
  assert.equal(r.area, 6);
  assert.equal(r.holes, 0);
  assert.equal(r.euler, 1);
  assert.deepEqual(r.bbox, { minRow: 0, maxRow: 0, minCol: 0, maxCol: 0 });
  assert.equal(r.touchesBorder, true);
});

test("ring: one region enclosing exactly one hole with correct pixel/physical areas", () => {
  const m: BinMatrix = [
    [1, 1, 1, 1, 1],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
    [1, 1, 1, 1, 1],
  ];
  const rep = run(m, 4);
  assert.equal(rep.regions.length, 1);
  assert.equal(rep.regions[0].pixelCount, 16);
  assert.equal(rep.regions[0].area, 96);
  assert.equal(rep.regions[0].holes, 1);
  assert.equal(rep.regions[0].euler, 0);
  assert.equal(rep.holes.length, 1);
  assert.equal(rep.holes[0].pixelCount, 9);
  assert.equal(rep.holes[0].area, 54);
});

test("diagonal pixels: connected under 8 but separated under 4 (complement changes holes)", () => {
  const m: BinMatrix = [
    [1, 0],
    [0, 1],
  ];
  assert.equal(run(m, 8).regions.length, 1);
  assert.equal(run(m, 4).regions.length, 2);
});

test("edge-touching background pocket is exterior, not a hole", () => {
  // A "C" shape open to the top border: the inside pocket reaches the border.
  const m: BinMatrix = [
    [1, 0, 1],
    [1, 0, 1],
    [1, 1, 1],
  ];
  const rep = run(m, 4);
  assert.equal(rep.regions.length, 1);
  assert.equal(rep.regions[0].holes, 0);
  assert.equal(rep.regions[0].euler, 1);
  assert.equal(rep.holes.length, 0);
  assert.equal(rep.regions[0].touchesBorder, true);
});

test("all-empty and all-full matrices give well-defined results", () => {
  const empty = run([
    [0, 0],
    [0, 0],
  ]);
  assert.equal(empty.regions.length, 0);
  assert.equal(empty.pixelCount, 0);
  assert.equal(empty.holes.length, 0);
  const full = run([
    [1, 1],
    [1, 1],
  ]);
  assert.equal(full.regions.length, 1);
  assert.equal(full.regions[0].holes, 0);
  assert.equal(full.regions[0].pixelCount, 4);
});

test("mask-outside pixels never enter area denominators and regions stay isolated", () => {
  const m: BinMatrix = [
    [1, 1, 1],
    [1, 1, 1],
    [1, 1, 1],
  ];
  const mask: BinMatrix = [
    [1, 0, 1],
    [0, 0, 0],
    [1, 0, 1],
  ];
  const rep = run(m, 4, mask);
  assert.equal(rep.pixelCount, 4);
  assert.equal(rep.regions.length, 4);
});

test("label numbers are deterministic in raster order", () => {
  const m: BinMatrix = [
    [0, 1, 0, 1],
    [0, 1, 0, 0],
    [1, 0, 0, 1],
  ];
  const rep = run(m, 4);
  assert.deepEqual(rep.regions.map((r) => r.label), [1, 2, 3, 4]);
  // First label is the top-row-leftmost blob.
  assert.deepEqual(rep.regions[0].bbox, { minRow: 0, maxRow: 1, minCol: 1, maxCol: 1 });
})
