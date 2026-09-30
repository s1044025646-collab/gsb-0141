import type { DatabaseSync } from "node:sqlite";
import type { BinMatrix, BorderMode, ChainStep, Connectivity, LabelReport } from "./types.ts";
import { cloneMatrix, matricesEqual, validatePayload, type ValidationError } from "./matrix.ts";
import { close, dilate, erode, normalizeSE, open } from "./morphology.ts";
import { labelAndMeasure } from "./components.ts";
import { createRepository, type Repository } from "./db.ts";
import { ApiError } from "./errors.ts";

export interface Clock {
  now(): number;
}

export interface ImportInput {
  name: string;
  payload: Parameters<typeof validatePayload>[0];
}

export interface ChainRequest {
  imageId: number;
  sourceVersionId: number;
  steps: ChainStep[];
  idempotencyKey?: string;
}

export interface ChainResponse {
  chainId: number;
  steps: Array<{
    seq: number;
    op: string;
    outputVersionId: number;
    report: LabelReport | null;
  }>;
  finalVersionId: number;
}

const VALID_OPS = new Set(["dilate", "erode", "open", "close", "label", "filter", "merge"]);

export class MorphService {
  private repo: Repository;
  private clock: Clock;

  constructor(db: DatabaseSync, clock: Clock = { now: () => Date.now() }) {
    this.repo = createRepository(db);
    this.clock = clock;
  }

  importImage(input: ImportInput): { imageId: number; versionId: number } {
    let payload;
    try {
      payload = validatePayload(input.payload);
    } catch (err) {
      throw new ApiError("VALIDATION_ERROR", (err as ValidationError).message);
    }
    return this.repo.tx(() => {
      const imageId = this.repo.createImage(input.name, this.clock.now());
      const v = this.repo.addVersion({
        imageId,
        parentVersionId: null,
        kind: "original",
        data: payload.data,
        mask: payload.mask,
        pixelX: payload.pixelSize.x,
        pixelY: payload.pixelSize.y,
        pixelUnit: payload.pixelSize.unit ?? "px",
        now: this.clock.now(),
      });
      return { imageId, versionId: v.id };
    });
  }

  registerSE(input: {
    name: string;
    shape: BinMatrix;
    anchor?: [number, number];
  }): void {
    try {
      const se = normalizeSE({
        name: input.name,
        shape: input.shape,
        anchor: input.anchor ?? [
          Math.floor((input.shape.length - 1) / 2),
          Math.floor((input.shape[0].length - 1) / 2),
        ],
      });
      this.repo.upsertSE({
        name: se.name,
        shape: se.shape,
        anchorRow: se.anchor[0],
        anchorCol: se.anchor[1],
        now: this.clock.now(),
      });
    } catch (err) {
      throw new ApiError("VALIDATION_ERROR", (err as Error).message);
    }
  }

  private resolveSE(name: string | undefined) {
    if (!name) throw new ApiError("VALIDATION_ERROR", `op requires an SE name`);
    const stored = this.repo.getSEByName(name);
    if (!stored) throw new ApiError("NOT_FOUND", `structuring element "${name}" not found`);
    return { name, shape: stored.shape, anchor: [stored.anchorRow, stored.anchorCol] as [number, number] };
  }

  /**
   * Execute a processing chain. Every step reads a version, computes a new
   * matrix, and stores a new version referencing its source, so originals are
   * never mutated. Repeating the whole request with the same
   * idempotencyKey returns the stored chain without creating new versions.
   */
  runChain(req: ChainRequest): ChainResponse {
    const source = this.repo.getVersion(req.sourceVersionId);
    if (!source || source.imageId !== req.imageId) {
      throw new ApiError("NOT_FOUND", "source version not found for image");
    }

    if (req.idempotencyKey) {
      const existing = this.repo.findChainByKey(req.imageId, req.idempotencyKey);
      if (existing !== undefined) {
        return this.chainResponse(existing);
      }
    }

    if (!Array.isArray(req.steps) || req.steps.length === 0) {
      throw new ApiError("VALIDATION_ERROR", "steps must be a non-empty array");
    }
    req.steps.forEach((s, i) => {
      if (!VALID_OPS.has(s.op)) throw new ApiError("UNSUPPORTED_OP", `step ${i}: unknown op "${s.op}"`);
    });

    return this.repo.tx(() => {
      const chainId = this.repo.createChain(
        req.imageId,
        req.sourceVersionId,
        req.idempotencyKey ?? null,
        this.clock.now(),
      );
      let currentVersionId = req.sourceVersionId;
      const out: ChainResponse["steps"] = [];
      req.steps.forEach((step, i) => {
        const inputVersion = this.repo.getVersion(currentVersionId)!;
        const { data, mask } = this.repo.getVersionData(currentVersionId);
        const border: BorderMode = step.border ?? "zero";
        let result: BinMatrix = cloneMatrix(data);
        let report: LabelReport | null = null;
        const seNeeded = step.op === "dilate" || step.op === "erode" || step.op === "open" || step.op === "close";
        const se = seNeeded ? this.resolveSE(step.se) : undefined;

        switch (step.op) {
          case "dilate":
            result = dilate(data, mask, se!, { border });
            break;
          case "erode":
            result = erode(data, mask, se!, { border });
            break;
          case "open":
            result = open(data, mask, se!, { border });
            break;
          case "close":
            result = close(data, mask, se!, { border });
            break;
          case "label":
          case "filter":
          case "merge":
            result = this.applyLabelFamily(step, data, mask, inputVersion, i);
            break;
        }

        const outputVersion = this.repo.addVersion({
          imageId: req.imageId,
          parentVersionId: currentVersionId,
          kind: step.op,
          data: result,
          mask,
          pixelX: inputVersion.pixelX,
          pixelY: inputVersion.pixelY,
          pixelUnit: inputVersion.pixelUnit,
          now: this.clock.now(),
        });

        if (step.op === "label" || step.op === "filter" || step.op === "merge") {
          const conn: Connectivity = step.connectivity === 8 ? 8 : 4;
          report = labelAndMeasure(
            result,
            mask,
            { x: inputVersion.pixelX, y: inputVersion.pixelY, unit: inputVersion.pixelUnit },
            conn,
            border,
          );
        }

        this.repo.addStep({
          chainId,
          seq: i,
          op: step.op,
          paramsJson: JSON.stringify(stripUndefined(step)),
          inputVersionId: currentVersionId,
          outputVersionId: outputVersion.id,
          report,
          borderMode: border,
          now: this.clock.now(),
        });
        currentVersionId = outputVersion.id;
        out.push({ seq: i, op: step.op, outputVersionId: outputVersion.id, report });
      });
      return { chainId, steps: out, finalVersionId: currentVersionId };
    });
  }

  private applyLabelFamily(
    step: ChainStep,
    data: BinMatrix,
    mask: BinMatrix,
    versionInfo: { pixelX: number; pixelY: number; pixelUnit: string },
    stepIndex: number,
  ): BinMatrix {
    const conn: Connectivity = step.connectivity === 8 ? 8 : 4;
    const border: BorderMode = step.border ?? "zero";
    const report = labelAndMeasure(
      data,
      mask,
      { x: versionInfo.pixelX, y: versionInfo.pixelY, unit: versionInfo.pixelUnit },
      conn,
      border,
    );
    if (step.op === "label") return cloneMatrix(data);
    if (step.op === "filter") {
      const min = step.minArea ?? -Infinity;
      const max = step.maxArea ?? Infinity;
      if (!Number.isFinite(min) && !Number.isFinite(max) && step.minArea === undefined && step.maxArea === undefined) {
        throw new ApiError("VALIDATION_ERROR", `step ${stepIndex}: filter needs minArea and/or maxArea`);
      }
      const keep = new Set(
        report.regions.filter((rg) => rg.area >= min && rg.area <= max).map((rg) => rg.label),
      );
      return report.labels.map((row) => row.map((l) => (keep.has(l) ? 1 : 0)));
    }
    // merge: union the listed labelled components (diagonally separated pieces
    // become one region); every other component stays foreground unchanged.
    if (!Array.isArray(step.labels) || step.labels.length === 0) {
      throw new ApiError("VALIDATION_ERROR", `step ${stepIndex}: merge needs a non-empty labels array`);
    }
    const wanted = new Set(step.labels);
    const known = new Set(report.regions.map((rg) => rg.label));
    for (const l of wanted) {
      if (!known.has(l)) throw new ApiError("VALIDATION_ERROR", `step ${stepIndex}: label ${l} does not exist`);
    }
    return report.labels.map((row) => row.map((l) => (l > 0 ? 1 : 0)));
  }

  private chainResponse(chainId: number): ChainResponse {
    const steps = this.repo.listSteps(chainId);
    return {
      chainId,
      steps: steps.map((s) => ({
        seq: s.seq,
        op: s.op,
        outputVersionId: s.outputVersionId,
        report: s.report,
      })),
      finalVersionId: steps[steps.length - 1].outputVersionId,
    };
  }

  getReport(chainId: number, seq?: number): LabelReport | null {
    const steps = this.repo.listSteps(chainId);
    const step = seq === undefined ? [...steps].reverse().find((s) => s.report) : steps.find((s) => s.seq === seq);
    if (!step) throw new ApiError("NOT_FOUND", "no labelled report for this chain/step");
    return step.report;
  }

  listRegions(
    chainId: number,
    page: number,
    pageSize: number,
  ): { total: number; page: number; pageSize: number; items: LabelReport["regions"] } {
    const report = this.getReport(chainId);
    if (!report) return { total: 0, page, pageSize, items: [] };
    const start = page * pageSize;
    return {
      total: report.regions.length,
      page,
      pageSize,
      items: report.regions.slice(start, start + pageSize),
    };
  }

  getVersionMatrix(versionId: number): { data: BinMatrix; mask: BinMatrix } {
    return this.repo.getVersionData(versionId);
  }

  listVersions(imageId: number) {
    return this.repo.listVersions(imageId);
  }

  compareVersions(aVersionId: number, bVersionId: number) {
    const a = this.repo.getVersionData(aVersionId);
    const b = this.repo.getVersionData(bVersionId);
    if (!matricesEqual(a.mask, b.mask)) {
      throw new ApiError("VALIDATION_ERROR", "versions have different masks");
    }
    let gained = 0;
    let lost = 0;
    let unchanged = 0;
    for (let r = 0; r < a.data.length; r++) {
      for (let c = 0; c < a.data[r].length; c++) {
        if (a.mask[r][c] === 0) continue;
        if (a.data[r][c] === b.data[r][c]) unchanged += a.data[r][c];
        else if (a.data[r][c] === 0 && b.data[r][c] === 1) gained++;
        else lost++;
      }
    }
    return { gained, lost, unchangedForeground: unchanged };
  }
}

function stripUndefined<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}
