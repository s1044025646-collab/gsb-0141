import { describe, it, expect } from 'vitest';
import { matrixFromRows, toRows, maskFromRows } from '../src/core/matrix.js';
import {
  dilate,
  erode,
  opening,
  closing,
  seOffsets,
  StructElement,
} from '../src/core/morphology.js';

const cross: StructElement = {
  name: 'cross',
  shape: [
    [0, 1, 0],
    [1, 1, 1],
    [0, 1, 0],
  ],
  anchorRow: 1,
  anchorCol: 1,
};

describe('结构元素反射与锚点', () => {
  it('对称十字的反射位移集合', () => {
    const { raw, reflected } = seOffsets(cross);
    expect(raw).toEqual(
      expect.arrayContaining([
        [-1, 0],
        [0, -1],
        [0, 0],
        [0, 1],
        [1, 0],
      ]),
    );
    expect(reflected.sort()).toEqual(raw.sort());
  });

  it('非对称结构元素反射取负', () => {
    const se: StructElement = {
      name: 'asym',
      shape: [
        [1, 0],
        [0, 1],
      ],
      anchorRow: 0,
      anchorCol: 0,
    };
    const { raw, reflected } = seOffsets(se);
    expect(raw).toEqual([
      [0, 0],
      [1, 1],
    ]);
    expect(reflected).toEqual([
      [0, 0],
      [-1, -1],
    ]);
  });

  it('锚点越界或空集合报错', () => {
    expect(() =>
      seOffsets({ name: 'x', shape: [[1]], anchorRow: 1, anchorCol: 0 }),
    ).toThrow(/锚点/);
    expect(() =>
      seOffsets({ name: 'x', shape: [[0]], anchorRow: 0, anchorCol: 0 }),
    ).toThrow(/空集合/);
  });
});

describe('手工小矩阵集合运算核对', () => {
  // 单个中心像元，3x3，远离边界
  const dot = matrixFromRows([
    [0, 0, 0],
    [0, 1, 0],
    [0, 0, 0],
  ]);

  it('膨胀单点得到十字（集合平移并集，非计数）', () => {
    expect(toRows(dilate(dot, cross))).toEqual([
      [0, 1, 0],
      [1, 1, 1],
      [0, 1, 0],
    ]);
  });

  it('腐蚀十字得到单点（对偶核对）', () => {
    const plus = matrixFromRows([
      [0, 1, 0],
      [1, 1, 1],
      [0, 1, 0],
    ]);
    expect(toRows(erode(plus, cross))).toEqual(toRows(dot));
  });

  it('边界腐蚀按外部 0：贴边前景被腐蚀掉', () => {
    const edge = matrixFromRows([
      [1, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ]);
    // 任何形状（含中心）在角落都需要越界邻居 => 全空
    expect(toRows(erode(edge, cross))).toEqual([
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ]);
  });

  it('边界膨胀不越界（外部取值策略生效）', () => {
    const corner = matrixFromRows([
      [1, 0],
      [0, 0],
    ]);
    expect(toRows(dilate(corner, cross))).toEqual([
      [1, 1],
      [1, 0],
    ]);
  });

  it('非对称 SE：膨胀方向由反射决定', () => {
    const se: StructElement = {
      name: 'right',
      // 只有锚点右侧一个成员
      shape: [[1, 1]],
      anchorRow: 0,
      anchorCol: 0,
    };
    const m = matrixFromRows([
      [0, 1, 0, 0],
    ]);
    // 成员位移 { (0,0),(0,1) }：膨胀为 A ∪ A_(右移1)，即向右生长
    expect(toRows(dilate(m, se))).toEqual([
      [0, 1, 1, 0],
    ]);
    // 腐蚀要求 p 与 p+(0,1)（右侧）都为前景 => 无（右侧像元为背景或越界）
    expect(toRows(erode(m, se))).toEqual([
      [0, 0, 0, 0],
    ]);
    const m2 = matrixFromRows([
      [1, 1, 0, 0],
    ]);
    // 只有 col0 的右侧也是前景；col1 右侧越界（外部 0）
    expect(toRows(erode(m2, se))).toEqual([
      [1, 0, 0, 0],
    ]);
  });
});

describe('开闭运算与幂等', () => {
  it('开运算去除小突起，远离边界时幂等', () => {
    const m = matrixFromRows([
      [0, 0, 0, 0, 0, 0, 0],
      [0, 1, 1, 1, 1, 1, 0],
      [0, 1, 1, 1, 1, 1, 0],
      [0, 1, 1, 1, 1, 0, 0], // 下方缺一块，右下角有凸起
      [0, 1, 1, 1, 1, 1, 0],
      [0, 0, 1, 0, 0, 0, 0], // 单像元突起
      [0, 0, 0, 0, 0, 0, 0],
    ]);
    const once = opening(m, cross);
    const twice = opening(once, cross);
    expect(toRows(twice)).toEqual(toRows(once));
  });

  it('闭运算填充小孔，远离边界时幂等', () => {
    const m = matrixFromRows([
      [0, 0, 0, 0, 0, 0, 0],
      [0, 1, 1, 1, 1, 1, 0],
      [0, 1, 1, 0, 1, 1, 0],
      [0, 1, 1, 1, 1, 1, 0],
      [0, 0, 0, 0, 0, 0, 0],
    ]);
    const once = closing(m, cross);
    const twice = closing(once, cross);
    expect(toRows(twice)).toEqual(toRows(once));
    // 中心小孔被闭运算填上
    expect(once.data[2 * 7 + 3]).toBe(1);
  });

  it('开运算不增大原集合、闭运算不缩小原集合（图案远离边界）', () => {
    // 9x9，图案置于内部 5x5，外圈留空以消除边界 outside-as-zero 的影响
    const m = matrixFromRows([
      [0, 0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 1, 1, 0, 0, 1, 0, 0],
      [0, 0, 1, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 1, 1, 0, 0, 0],
      [0, 0, 0, 0, 1, 1, 0, 0, 0],
      [0, 0, 1, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0, 0],
    ]);
    const op = opening(m, cross);
    const cl = closing(m, cross);
    for (let i = 0; i < m.data.length; i++) {
      if (op.data[i] === 1) expect(m.data[i]).toBe(1);
      if (m.data[i] === 1) expect(cl.data[i]).toBe(1);
    }
  });
});

describe('掩膜隔离', () => {
  it('掩膜外前景被忽略，膨胀不写入掩膜外', () => {
    const m = matrixFromRows([
      [1, 1, 0],
      [1, 0, 0],
      [0, 0, 0],
    ]);
    const mask = maskFromRows([
      [1, 1, 0],
      [1, 1, 0],
      [0, 0, 0],
    ]);
    const d = dilate(m, cross, mask);
    expect(toRows(d)).toEqual([
      [1, 1, 0],
      [1, 1, 0],
      [0, 0, 0],
    ]);
  });
});
