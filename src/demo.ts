import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { openDatabase } from "./db.ts";
import { MorphService } from "./service.ts";
import { ringMatrix } from "./generator.ts";

/**
 * Repeatable end-to-end demo against an in-project SQLite file.
 * Run: npm run demo   (prints deterministic results; no network, no randomness)
 */
const DB_PATH = resolve("data/demo.sqlite");

function main(): void {
  rmSync(DB_PATH, { force: true });
  for (const suffix of ["-wal", "-shm"]) rmSync(DB_PATH + suffix, { force: true });
  const db = openDatabase(DB_PATH);
  let tick = 1000;
  const service = new MorphService(db, { now: () => (tick += 1) });

  const data = ringMatrix(7, 1);
  const mask = data.map((row) => row.map(() => 1));
  const imported = service.importImage({
    name: "demo-ring",
    payload: {
      width: 7,
      height: 7,
      data,
      mask,
      pixelSize: { x: 2, y: 2, unit: "um" },
    },
  });
  console.log(`imported image=${imported.imageId} version=${imported.versionId}`);

  service.registerSE({
    name: "L",
    shape: [
      [1, 0],
      [1, 1],
    ],
    anchor: [0, 0],
  });

  const chain = service.runChain({
    imageId: imported.imageId,
    sourceVersionId: imported.versionId,
    idempotencyKey: "demo-chain-v1",
    steps: [
      { op: "label", connectivity: 4, border: "zero" },
      { op: "dilate", se: "L", border: "zero" },
      { op: "label", connectivity: 4, border: "zero" },
    ],
  });
  const before = chain.steps[0].report!;
  const after = chain.steps[2].report!;
  console.log(
    `before: regions=${before.regions.length} holes=${before.holes.length} regionArea=${before.regions[0]?.area}um^2 px=${before.regions[0]?.pixelCount}`,
  );
  console.log(`after dilation: regions=${after.regions.length} holes=${after.holes.length}`);

  const again = service.runChain({
    imageId: imported.imageId,
    sourceVersionId: imported.versionId,
    idempotencyKey: "demo-chain-v1",
    steps: [],
  });
  console.log(`idempotent resubmit returns chain=${again.chainId} (same as ${chain.chainId})`);

  const cmp = service.compareVersions(chain.steps[0].outputVersionId, chain.steps[2].outputVersionId);
  console.log(`compare: gained=${cmp.gained} lost=${cmp.lost}`);
  db.close();
  console.log(`demo db at ${DB_PATH}`);
}

main();
