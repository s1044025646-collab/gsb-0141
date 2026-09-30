import { describe, it, expect } from 'vitest';
import { matrixFromRows, maskFromRows } from '../src/core/matrix.js';
import { labelComponents, labelsToRows } from '../src/core/labeling.js';
import { measure } from '../src/core/regions.js';
import { ring, diagonal, filled, empty } from '../src/core/synthetic.js';

describe('连通标签夹具', () => {
  it('单像元：一个标签', () => {
    const m = matrixFromRows([
      [0, 0],
      [0, 1],
    ]);
    const r = labelComponents(m, 8);
    expect(r.count).toBe(1);
    expect(r.labels[3]).toBe(1);
  });

  it('对角相连：4 连通为两块，8 连通为一块（确定性编号）', () => {
    const m = matrixFromRows([
      [1, 0],
      [0, 1],
    ]);
    const c4 = labelComponents(m, 4);
    const c8 = labelComponents(m, 8);
    expect(c4.count).toBe(2);
    expect(c8.count).toBe(1);
    // 编号按行优先首次出现
    expect(labelsToRows(c4)).toEqual([
      [1, 0],
      [0, 2],
    ]);
  });

  it('对角线段 4/8 连通差异', () => {
    const m = diagonal(5, 5, 0, 0, 4, 1, 1);
    expect(labelComponents(m, 8).count).toBe(1);
    expect(labelComponents(m, 4).count).toBe(4);
  });

  it('全空零区域、全满单区域', () => {
    expect(labelComponents(empty(4, 4), 8).count).toBe(0);
    expect(labelComponents(filled(4, 4), 8).count).toBe(1);
  });
});

describe('孔洞与欧拉数（互补连通性）', () => {
  it('环形：一个孔洞，区域欧拉=0，整体欧拉=0', () => {
    const m = ring(5, 5, 1, 1, 3, 3);
    const rep = measure(m, 4, { pixelHeight: 1, pixelWidth: 1 });
    expect(rep.regionCount).toBe(1);
    expect(rep.totalHoleCount).toBe(1);
    expect(rep.eulerNumber).toBe(0);
    expect(rep.regions[0].holeCount).toBe(1);
    expect(rep.regions[0].eulerNumber).toBe(0);
  });

  it('对角接触不封闭孔洞：前景 8 连通成环，但背景 4 连通对角泄漏', () => {
    // 外框四角的环壁像元仅角对角相接。
    // 前景 8 连通 + 背景 4 连通：四角经对角连成整个环，内部在 4 连通背景下无法经对角逃出 => 1 孔洞；
    // 前景 4 连通 + 背景 8 连通：环壁在四角断开成 4 段，内部沿 8 连通背景溢出 => 0 孔洞。
    const m = matrixFromRows([
      [0, 1, 1, 1, 0],
      [1, 0, 0, 0, 1],
      [1, 0, 0, 0, 1],
      [1, 0, 0, 0, 1],
      [0, 1, 1, 1, 0],
    ]);
    const rep8 = measure(m, 8, { pixelHeight: 1, pixelWidth: 1 });
    // 8 连通：四角对角相连为一个环
    expect(rep8.regionCount).toBe(1);
    expect(rep8.totalHoleCount).toBe(1);

    // 4 连通：环壁断成四段，孔洞消失
    const rep4 = measure(m, 4, { pixelHeight: 1, pixelWidth: 1 });
    expect(rep4.regionCount).toBe(4);
    expect(rep4.totalHoleCount).toBe(0);
  });

  it('触边背景是外部，不是孔洞', () => {
    // U 形开口朝边界
    const m = matrixFromRows([
      [1, 0, 1],
      [1, 0, 1],
      [1, 1, 1],
    ]);
    const rep = measure(m, 4, { pixelHeight: 1, pixelWidth: 1 });
    expect(rep.totalHoleCount).toBe(0);
    expect(rep.regions[0].touchesBorder).toBe(true);
  });

  it('触边前景区域标记 touchesBorder', () => {
    const m = matrixFromRows([
      [1, 1],
      [0, 0],
    ]);
    const rep = measure(m, 4, { pixelHeight: 1, pixelWidth: 1 });
    expect(rep.regions[0].touchesBorder).toBe(true);
  });
});

describe('面积换算与质心、包围盒', () => {
  it('像元数量与物理面积分开，非正方形像元正确', () => {
    const m = matrixFromRows([
      [1, 1],
      [1, 0],
    ]);
    const rep = measure(m, 8, { pixelHeight: 0.5, pixelWidth: 2, unit: 'mm' });
    expect(rep.regions[0].pixelCount).toBe(3);
    expect(rep.regions[0].area).toBeCloseTo(3 * 0.5 * 2, 10);
    // 质心像元坐标（像元中心）
    expect(rep.regions[0].centroidRow).toBeCloseTo((0.5 + 0.5 + 1.5) / 3, 10);
    expect(rep.regions[0].centroidCol).toBeCloseTo((0.5 + 1.5 + 0.5) / 3, 10);
    // 物理坐标
    expect(rep.regions[0].centroidX).toBeCloseTo(rep.regions[0].centroidCol * 2, 10);
    expect(rep.regions[0].centroidY).toBeCloseTo(rep.regions[0].centroidRow * 0.5, 10);
    expect(rep.regions[0].bbox).toEqual({ minRow: 0, maxRow: 1, minCol: 0, maxCol: 1 });
  });

  it('零面积区域不出现在结果中（全空）', () => {
    const rep = measure(empty(3, 3), 8, { pixelHeight: 1, pixelWidth: 1 });
    expect(rep.regionCount).toBe(0);
    expect(rep.foregroundArea).toBe(0);
    expect(rep.foregroundFraction).toBe(0);
    expect(rep.eulerNumber).toBe(0);
  });

  it('孔洞面积可定位', () => {
    const m = ring(5, 5, 1, 1, 3, 3);
    const rep = measure(m, 4, { pixelHeight: 1, pixelWidth: 1 });
    expect(rep.holes[0].pixelCount).toBe(1);
    expect(rep.holes[0].anchor).toEqual({ row: 2, col: 2 });
    expect(rep.holes[0].surroundingLabels).toEqual([1]);
  });
});

describe('掩膜隔离测量', () => {
  it('掩膜外像元不计入面积分母', () => {
    const m = matrixFromRows([
      [1, 1, 1],
      [1, 1, 1],
      [1, 1, 1],
    ]);
    const mask = maskFromRows([
      [1, 1, 0],
      [1, 1, 0],
      [0, 0, 0],
    ]);
    const rep = measure(m, 8, { pixelHeight: 1, pixelWidth: 1 }, mask);
    expect(rep.validPixelCount).toBe(4);
    expect(rep.foregroundPixelCount).toBe(4);
    expect(rep.foregroundFraction).toBe(1);
  });

  it('与掩膜外相邻的背景凹陷算外部（不成孔洞）', () => {
    // 有效区域内前景环，但环的开口贴掩膜边
    const m = matrixFromRows([
      [1, 1, 1],
      [1, 0, 1],
      [1, 1, 0],
    ]);
    const mask = maskFromRows([
      [1, 1, 1],
      [1, 1, 1],
      [1, 1, 0],
    ]);
    const rep = measure(m, 4, { pixelHeight: 1, pixelWidth: 1 }, mask);
    expect(rep.totalHoleCount).toBe(0);
  });

  it('完全被前景包围且不接触掩膜外的背景是孔洞', () => {
    const m = matrixFromRows([
      [1, 1, 1, 0],
      [1, 0, 1, 0],
      [1, 1, 1, 0],
      [0, 0, 0, 0],
    ]);
    const mask = maskFromRows([
      [1, 1, 1, 1],
      [1, 1, 1, 1],
      [1, 1, 1, 1],
      [1, 1, 1, 1],
    ]);
    const rep = measure(m, 4, { pixelHeight: 1, pixelWidth: 1 }, mask);
    expect(rep.totalHoleCount).toBe(1);
  });
});
