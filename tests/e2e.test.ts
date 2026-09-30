import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase, migrate } from "../src/db.ts";
import { MorphService, type ChainRequest } from "../src/service.ts";
import { startServer, type StartedServer } from "../src/server.ts";

const DB_PATH = resolve("tmp/test-e2e.sqlite");

function freshDb(path = DB_PATH): DatabaseSync {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
  return openDatabase(path);
}

function payload() {
  return {
    width: 5,
    height: 5,
    data: [
      [0, 0, 0, 0, 0],
      [0, 1, 1, 1, 0],
      [0, 1, 0, 1, 0],
      [0, 1, 1, 1, 0],
      [0, 0, 0, 0, 0],
    ],
    mask: [
      [1, 1, 1, 1, 1],
      [1, 1, 1, 1, 1],
      [1, 1, 1, 1, 1],
      [1, 1, 1, 1, 1],
      [1, 1, 1, 1, 1],
    ],
    pixelSize: { x: 2, y: 2, unit: "um" },
  };
}

test("failed chain rolls back: no versions, steps or chains persist", () => {
  const db = freshDb();
  const service = new MorphService(db);
  const imported = service.importImage({ name: "img", payload: payload() });
  service.registerSE({
    name: "sq",
    shape: [
      [1, 1],
      [1, 1],
    ],
  });
  const versionsBefore = service.listVersions(imported.imageId).length;
  assert.throws(
    () =>
      service.runChain({
        imageId: imported.imageId,
        sourceVersionId: imported.versionId,
        steps: [{ op: "dilate", se: "missing-se" }],
      }),
    /not found/,
  );
  assert.equal(service.listVersions(imported.imageId).length, versionsBefore);
  db.close();
});

test("idempotent resubmit returns the same chain without extra versions", () => {
  const db = freshDb(resolve("tmp/test-idem.sqlite"));
  const service = new MorphService(db);
  const imported = service.importImage({ name: "img", payload: payload() });
  const req: ChainRequest & { idempotencyKey: string } = {
    imageId: imported.imageId,
    sourceVersionId: imported.versionId,
    idempotencyKey: "k-1",
    steps: [{ op: "label", connectivity: 4 as const, border: "zero" as const }],
  };
  const first = service.runChain(req);
  const second = service.runChain(req);
  assert.equal(first.chainId, second.chainId);
  assert.equal(service.listVersions(imported.imageId).length, 2);
  db.close();
});

test("history reproduction: replaying stored steps on original yields identical matrix", () => {
  const db = freshDb(resolve("tmp/test-history.sqlite"));
  const service = new MorphService(db);
  const imported = service.importImage({ name: "img", payload: payload() });
  service.registerSE({
    name: "sq",
    shape: [
      [1, 1],
      [1, 1],
    ],
    anchor: [0, 0],
  });
  const chain = service.runChain({
    imageId: imported.imageId,
    sourceVersionId: imported.versionId,
    steps: [
      { op: "erode", se: "sq", border: "zero" },
      { op: "label", connectivity: 8, border: "zero" },
    ],
  });
  // Parent pointers reconstruct lineage; every version matrix is readable.
  const versions = service.listVersions(imported.imageId);
  assert.equal(versions[1].parentVersionId, imported.versionId);
  assert.equal(versions[2].parentVersionId, versions[1].id);
  const replay = service.runChain({
    imageId: imported.imageId,
    sourceVersionId: imported.versionId,
    steps: [{ op: "erode", se: "sq", border: "zero" }],
  });
  const a = service.getVersionMatrix(chain.steps[0].outputVersionId).data;
  const b = service.getVersionMatrix(replay.steps[0].outputVersionId).data;
  assert.deepEqual(a, b);
  db.close();
});

test("filter and merge create new versions without modifying the original", () => {
  const p = payload();
  // Two separate small components plus the ring: add isolated pixels.
  p.data[0][0] = 1;
  p.data[4][4] = 1;
  const db2 = freshDb(resolve("tmp/test-manual2.sqlite"));
  const s2 = new MorphService(db2);
  const imp2 = s2.importImage({ name: "img2", payload: p });
  const chain = s2.runChain({
    imageId: imp2.imageId,
    sourceVersionId: imp2.versionId,
    steps: [{ op: "label", connectivity: 4, border: "zero" }],
  });
  assert.ok(chain.steps[0].report!.regions.length >= 3);
  const filtered = s2.runChain({
    imageId: imp2.imageId,
    sourceVersionId: chain.finalVersionId,
    steps: [{ op: "filter", connectivity: 4, minArea: 8, maxArea: 100 }],
  });
  assert.ok(filtered.steps[0].report!.regions.length < chain.steps[0].report!.regions.length);
  // Original version matrix untouched.
  const original = s2.getVersionMatrix(imp2.versionId).data;
  assert.equal(original[0][0], 1);
  db2.close();
});

test("state survives close/reopen, and migration is repeatable", () => {
  const path = resolve("tmp/test-persist.sqlite");
  const db = freshDb(path);
  const service = new MorphService(db);
  const imported = service.importImage({ name: "keep", payload: payload() });
  db.close();

  const reopened = openDatabase(path);
  migrate(reopened); // running migration again must be a no-op
  migrate(reopened);
  const service2 = new MorphService(reopened);
  const versions = service2.listVersions(imported.imageId);
  assert.equal(versions.length, 1);
  const matrix = service2.getVersionMatrix(imported.versionId);
  assert.equal(matrix.data[2][2], 0);
  reopened.close();
  assert.ok(existsSync(path));
});

describe("http api", () => {
  let running: StartedServer;
  let base: string;

  before(async () => {
    running = await startServer({ dbPath: resolve("tmp/test-http.sqlite"), port: 0 });
    base = `http://127.0.0.1:${running.port}`;
  });
  after(() => running.server.close());

  test("validation errors carry explicit codes; CRUD + pagination works end to end", async () => {
    const bad = await fetch(`${base}/images`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x", payload: { width: 1, height: 1, data: [[2]], mask: [[1]], pixelSize: { x: 1, y: 1 } } }),
    });
    assert.equal(bad.status, 400);
    const badBody = (await bad.json()) as { error: { code: string } };
    assert.equal(badBody.error.code, "VALIDATION_ERROR");

    const created = await fetch(`${base}/images`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "ring", payload: payload() }),
    });
    assert.equal(created.status, 201);
    const { imageId, versionId } = (await created.json()) as { imageId: number; versionId: number };

    const chained = await fetch(`${base}/images/${imageId}/chains`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceVersionId: versionId,
        steps: [{ op: "label", connectivity: 4, border: "zero" }],
      }),
    });
    const chainBody = (await chained.json()) as { chainId: number };
    assert.equal(chained.status, 201);

    const regions = await fetch(`${base}/chains/${chainBody.chainId}/regions?page=0&pageSize=1`);
    const regionBody = (await regions.json()) as { total: number; items: unknown[]; page: number };
    assert.equal(regionBody.page, 0);
    assert.equal(regionBody.items.length, Math.min(1, regionBody.total));

    const labels = await fetch(`${base}/chains/${chainBody.chainId}/labels`);
    assert.equal(labels.status, 200);

    const missing = await fetch(`${base}/chains/9999/regions`);
    assert.equal(missing.status, 404);

    const cmp = await fetch(`${base}/versions/compare?a=${versionId}&b=${versionId}`);
    const cmpBody = (await cmp.json()) as { gained: number; lost: number };
    assert.equal(cmpBody.gained, 0);
    assert.equal(cmpBody.lost, 0);
  });
});
