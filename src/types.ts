export type Connectivity = 4 | 8;

/** Image border rule for pixels outside the canvas (but inside the valid mask conceptually). */
export type BorderMode = "zero" | "one" | "mirror";

/** Rectangular binary matrix: rows of 0/1. */
export type BinMatrix = number[][];

export interface PixelSize {
  /** Physical width of one pixel, e.g. micrometres. */
  x: number;
  /** Physical height of one pixel. */
  y: number;
  /** Unit name, e.g. "um". Purely descriptive for reports. */
  unit?: string;
}

/** Structuring element definition. Coordinates are offsets from the anchor. */
export interface StructuringElement {
  name: string;
  /** Dense 0/1 matrix of the element shape; can be asymmetric. */
  shape: BinMatrix;
  /** Anchor position [row, col]. Defaults to the floor centre. */
  anchor: [number, number];
}

export interface VersionPayload {
  width: number;
  height: number;
  /** Foreground pixels (0/1), row-major. */
  data: BinMatrix;
  /** Valid-region mask (0/1). Pixels where mask=0 are excluded from every computation. */
  mask: BinMatrix;
  pixelSize: PixelSize;
}

export type MorphOpName =
  | "dilate"
  | "erode"
  | "open"
  | "close"
  | "label"
  | "filter"
  | "merge";

export interface ChainStep {
  op: MorphOpName;
  /** Name of the structuring element used by dilate/erode/open/close. */
  se?: string;
  /** Foreground connectivity for label; background uses the complementary one. */
  connectivity?: Connectivity;
  /** Value assumed for image pixels outside the canvas. */
  border?: BorderMode;
  /** filter: keep regions whose physical area is within [minArea, maxArea] (in unit^2). */
  minArea?: number;
  maxArea?: number;
  /** merge: region labels to merge into one region (in the input label matrix). */
  labels?: number[];
}

export interface RegionStats {
  label: number;
  pixelCount: number;
  /** physical area = pixelCount * pixelSize.x * pixelSize.y */
  area: number;
  centroid: { row: number; col: number; rowPhysical: number; colPhysical: number };
  bbox: { minRow: number; maxRow: number; minCol: number; maxCol: number };
  holes: number;
  euler: number;
  /** True when the component touches the valid-mask boundary (cannot enclose exterior there). */
  touchesBorder: boolean;
}

export interface HoleInfo {
  /** Stable hole id: `${regionLabel}-${backgroundLabel}`. */
  id: string;
  regionLabel: number;
  backgroundLabel: number;
  pixelCount: number;
  area: number;
  /** One representative background pixel (row, col) for CLI/API location. */
  seed: [number, number];
  bbox: { minRow: number; maxRow: number; minCol: number; maxCol: number };
  /** True when the pocket touches the mask border, i.e. an edge-touching hole. */
  touchesBorder: boolean;
}

export interface LabelReport {
  connectivity: Connectivity;
  border: BorderMode;
  /** 0 = background, positive = foreground labels. */
  labels: number[][];
  regions: RegionStats[];
  holes: HoleInfo[];
  pixelCount: number;
  physicalAreaUnit: string;
}
