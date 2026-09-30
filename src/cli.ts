import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { openDatabase } from "./db.ts";
import { MorphService } from "./service.ts";
import type { ChainStep } from "./types.ts";

const ROOT = resolve(import.meta.dirname, "..");
const DB_PATH = resolve(ROOT, "data/app.sqlite");
const PID_FILE = resolve(ROOT, "data/server.pid");
const PORT_FILE = resolve(ROOT, "data/server.port");

function usage(): never {
  console.error(
    [
      "Usage:",
      "  cli import --name NAME --file payload.json",
      "  cli se --name NAME --file se.json",
      "  cli chain --image ID --source-version ID --file steps.json [--idempotency-key KEY]",
      "  cli regions --chain ID [--page N --page-size N]",
      "  cli holes --chain ID",
      "  cli compare --a VERSION_ID --b VERSION_ID",
      "  cli export-labels --chain ID --out FILE",
      "  cli serve | stop",
    ].join("\n"),
  );
  process.exit(2);
}

function args(): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  const rest = process.argv.slice(2);
  const cmd = rest.shift();
  out._cmd = cmd ?? "";
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok.startsWith("--")) {
      const key = tok.slice(2);
      if (rest[i + 1] && !rest[i + 1].startsWith("--")) {
        out[key] = rest[++i];
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

function loadJson(file: string): unknown {
  return JSON.parse(readFileSync(resolve(file), "utf8"));
}

function foregroundCount(m: number[][]): number {
  let n = 0;
  for (const row of m) for (const v of row) if (v === 1) n++;
  return n;
}

async function main(): Promise<void> {
  const a = args();
  const cmd = String(a._cmd);

  if (cmd === "serve") {
    mkdirSync(resolve(ROOT, "data"), { recursive: true });
    const child = spawn(process.execPath, [resolve(import.meta.dirname, "server-process.ts")], {
      cwd: ROOT,
      detached: true,
      stdio: "ignore",
    });
    writeFileSync(PID_FILE, String(child.pid));
    child.unref();
    // Wait briefly for the port file written by the child.
    for (let i = 0; i < 50 && !existsSync(PORT_FILE); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (existsSync(PORT_FILE)) {
      console.log(`server started on 127.0.0.1:${readFileSync(PORT_FILE, "utf8").trim()} pid=${child.pid}`);
    } else {
      console.log(`server started pid=${child.pid} (port file pending; see data/server.port)`);
    }
    return;
  }

  if (cmd === "stop") {
    if (!existsSync(PID_FILE)) {
      console.log("no pid file; server not managed here");
      return;
    }
    const pid = Number(readFileSync(PID_FILE, "utf8").trim());
    try {
      process.kill(pid);
      console.log(`stopped pid ${pid}`);
    } catch {
      console.log(`pid ${pid} not running; removing stale pid file`);
    }
    unlinkSync(PID_FILE);
    if (existsSync(PORT_FILE)) unlinkSync(PORT_FILE);
    return;
  }

  const db = openDatabase(DB_PATH);
  const service = new MorphService(db);

  if (cmd === "import") {
    if (typeof a.name !== "string" || typeof a.file !== "string") usage();
    const payload = loadJson(a.file);
    const out = service.importImage({ name: a.name, payload: payload as never });
    console.log("before: no versions");
    console.log(`imported image=${out.imageId} originalVersion=${out.versionId}`);
    db.close();
    return;
  }

  if (cmd === "se") {
    if (typeof a.name !== "string" || typeof a.file !== "string") usage();
    const se = loadJson(a.file) as { shape: number[][]; anchor?: [number, number] };
    service.registerSE({ name: a.name, shape: se.shape, anchor: se.anchor });
    console.log(`registered SE "${a.name}" ${se.shape.length}x${se.shape[0].length}`);
    db.close();
    return;
  }

  if (cmd === "chain") {
    const imageId = Number(a.image);
    const sourceVersionId = Number(a["source-version"]);
    if (!Number.isInteger(imageId) || !Number.isInteger(sourceVersionId) || typeof a.file !== "string") usage();
    const steps = loadJson(a.file) as ChainStep[];
    const before = foregroundCount(service.getVersionMatrix(sourceVersionId).data);
    const out = service.runChain({
      imageId,
      sourceVersionId,
      steps,
      idempotencyKey: typeof a["idempotency-key"] === "string" ? a["idempotency-key"] : undefined,
    });
    console.log(`step chain=${out.chainId} foregroundBefore=${before}`);
    for (const s of out.steps) {
      const after = foregroundCount(service.getVersionMatrix(s.outputVersionId).data);
      const regions = s.report?.regions.length ?? 0;
      const holes = s.report?.holes.length ?? 0;
      console.log(
        `  #${s.seq} ${s.op} -> version ${s.outputVersionId} foregroundAfter=${after} regions=${regions} holes=${holes}`,
      );
    }
    db.close();
    return;
  }

  if (cmd === "regions") {
    const page = Number(a.page ?? 0);
    const pageSize = Number(a["page-size"] ?? 50);
    const res = service.listRegions(Number(a.chain), page, pageSize);
    console.log(`total=${res.total} page=${res.page} pageSize=${res.pageSize}`);
    for (const r of res.items) {
      console.log(
        `label=${r.label} px=${r.pixelCount} area=${r.area.toFixed(4)} centroid=(${r.centroid.row.toFixed(2)},${r.centroid.col.toFixed(2)}) bbox=[${r.bbox.minRow},${r.bbox.minCol}..${r.bbox.maxRow},${r.bbox.maxCol}] holes=${r.holes} euler=${r.euler} border=${r.touchesBorder}`,
      );
    }
    db.close();
    return;
  }

  if (cmd === "holes") {
    const report = service.getReport(Number(a.chain));
    for (const h of report?.holes ?? []) {
      console.log(
        `hole=${h.id} region=${h.regionLabel} px=${h.pixelCount} area=${h.area.toFixed(4)} seed=(${h.seed[0]},${h.seed[1]}) bbox=[${h.bbox.minRow},${h.bbox.minCol}..${h.bbox.maxRow},${h.bbox.maxCol}]`,
      );
    }
    db.close();
    return;
  }

  if (cmd === "compare") {
    const aId = Number(a.a);
    const bId = Number(a.b);
    const res = service.compareVersions(aId, bId);
    console.log(`version ${aId} -> ${bId}: gained=${res.gained} lost=${res.lost} unchangedForeground=${res.unchangedForeground}`);
    db.close();
    return;
  }

  if (cmd === "export-labels") {
    if (typeof a.chain !== "string" && typeof a.chain !== "number") usage();
    const report = service.getReport(Number(a.chain));
    const labels = report?.labels ?? [];
    const text = labels.map((row) => row.join(" ")).join("\n") + "\n";
    if (typeof a.out === "string") {
      writeFileSync(resolve(a.out), text);
      console.log(`labels written to ${a.out} (${labels.length} rows)`);
    } else {
      process.stdout.write(text);
    }
    db.close();
    return;
  }

  usage();
}

main().catch((err) => {
  console.error(`error [${err.code ?? "INTERNAL"}]: ${err.message}`);
  process.exit(1);
});
