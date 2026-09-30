import { describe, it, expect, afterAll } from 'vitest';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db/store.js';
import { MorphService, ApiError } from '../src/service/service.js';
import { matrixFromRows, toRows } from '../src/core/matrix.js';
import { StructElement } from '../src/core/morphology.js';
import { ring } from '../src/core/synthetic.js';

const TMP = mkdtempSync(join(tmpdir(), 'morph-test-service-'));

interface Ctx {
  store: Store;
  svc: MorphService;
  path: string;
}

function fresh(): Ctx & { cleanup: () => void } {
  const path = join(TMP, `t-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const store = new Store(path);
  return {
    store,
    svc: new MorphService(store),
    path,
    cleanup: () => {
      try {
        store.close();
      } catch {
        /* ignore */
      }
    },
  };
}

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

afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe('服务层：版本与历史', () => {
  it('每步保留来源版本与中间矩阵，原图不被改写', () => {
    const { store, svc, cleanup } = fresh();
    try {
      const img = svc.importImage({
        name: 'ring',
        matrix: toRows(ring(7, 7, 2, 2, 4, 4)),
        pixelHeight: 0.1,
        pixelWidth: 0.1,
        unit: 'mm',
        connectivity: 4,
      });
      const orig = store.getVersion(img.versionId)!;
      const chain = svc.runChain({
        imageId: img.imageId,
        name: 'open',
        steps: [
          { op: 'erode', se: cross },
          { op: 'dilate', se: cross },
        ],
      });
      expect(chain.steps).toHaveLength(2);
      const steps = store.listSteps(chain.chainId);
      expect(steps[0].source_version_id).toBe(img.versionId);
      expect(steps[1].source_version_id).toBe(chain.steps[0].resultVersionId);
      expect(steps[0].boundary_policy).toBe('outside-as-zero');
      expect(store.getVersion(img.versionId)!.matrix_json).toBe(orig.matrix_json);
      expect(store.listVersions(img.imageId, 100, 0).total).toBe(3);
    } finally {
      cleanup();
    }
  });

  it('历史复现：从链首来源版本重算与存储结果一致', () => {
    const { svc, cleanup } = fresh();
    try {
      const img = svc.importImage({
        name: 'r',
        matrix: toRows(ring(7, 7, 1, 1, 5, 5)),
        pixelHeight: 1,
        pixelWidth: 1,
        connectivity: 4,
      });
      const chain = svc.runChain({
        imageId: img.imageId,
        name: 'c',
        steps: [
          { op: 'dilate', se: cross },
          { op: 'erode', se: cross },
          { op: 'open', se: cross },
        ],
      });
      expect(svc.replayChain(chain.chainId).reproduced).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('人工合并与过滤生成新版本，不改原图', () => {
    const { store, svc, cleanup } = fresh();
    try {
      const img = svc.importImage({
        name: 'm',
        matrix: [
          [1, 0, 0, 0],
          [0, 0, 0, 0],
          [0, 0, 0, 1],
          [0, 0, 0, 0],
        ],
        pixelHeight: 1,
        pixelWidth: 1,
        connectivity: 8,
      });
      const filterChain = svc.runChain({
        imageId: img.imageId,
        name: 'keep2',
        steps: [{ op: 'filter', params: { keepLabels: [2] } }],
      });
      const filtered = store.getVersion(filterChain.steps[0].resultVersionId)!;
      expect(JSON.parse(filtered.matrix_json)).toEqual([
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 1],
        [0, 0, 0, 0],
      ]);
      const mergeChain = svc.runChain({
        imageId: img.imageId,
        name: 'merge',
        startVersionId: img.versionId,
        steps: [{ op: 'merge', params: { versionId: filterChain.steps[0].resultVersionId } }],
      });
      expect(JSON.parse(store.getVersion(mergeChain.steps[0].resultVersionId)!.matrix_json)).toEqual([
        [1, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 1],
        [0, 0, 0, 0],
      ]);
      const v1 = store.getVersion(img.versionId)!;
      expect(v1.version).toBe(1);
      expect(JSON.parse(v1.matrix_json)[0][0]).toBe(1);
    } finally {
      cleanup();
    }
  });
});

describe('参数校验与失败路径', () => {
  it('非法矩阵/尺寸/连通性返回明确错误码', () => {
    const { svc, cleanup } = fresh();
    try {
      const codeOf = (fn: () => unknown): string => {
        try {
          fn();
          return 'NO_THROW';
        } catch (e) {
          return (e as ApiError).code;
        }
      };
      expect(codeOf(() => svc.importImage({ name: '', matrix: [[1]], pixelHeight: 1, pixelWidth: 1 }))).toBe(
        'INVALID_NAME',
      );
      expect(codeOf(() => svc.importImage({ name: 'a', matrix: [[2]], pixelHeight: 1, pixelWidth: 1 }))).toBe(
        'INVALID_MATRIX',
      );
      expect(codeOf(() => svc.importImage({ name: 'a', matrix: [[1]], pixelHeight: 0, pixelWidth: 1 }))).toBe(
        'INVALID_PIXEL_SIZE',
      );
      expect(
        codeOf(() =>
          svc.importImage({ name: 'a', matrix: [[1]], pixelHeight: 1, pixelWidth: 1, connectivity: 5 as unknown as 4 }),
        ),
      ).toBe('INVALID_CONNECTIVITY');
    } finally {
      cleanup();
    }
  });

  it('掩膜尺寸不匹配报错', () => {
    const { svc, cleanup } = fresh();
    try {
      let err: unknown;
      try {
        svc.importImage({
          name: 'a',
          matrix: [
            [1, 0],
            [0, 1],
          ],
          mask: [[1]],
          pixelHeight: 1,
          pixelWidth: 1,
        });
      } catch (e) {
        err = e;
      }
      expect((err as ApiError).code).toBe('INVALID_MASK');
    } finally {
      cleanup();
    }
  });

  it('形态学步骤缺少合法结构元素报错', () => {
    const { svc, cleanup } = fresh();
    try {
      const img = svc.importImage({ name: 'a', matrix: [[1]], pixelHeight: 1, pixelWidth: 1 });
      let err: unknown;
      try {
        svc.runChain({ imageId: img.imageId, name: 'x', steps: [{ op: 'dilate', se: null }] });
      } catch (e) {
        err = e;
      }
      expect((err as ApiError).code).toBe('INVALID_STRUCT_ELEMENT');
    } finally {
      cleanup();
    }
  });

  it('不存在的版本返回 404', () => {
    const { svc, cleanup } = fresh();
    try {
      try {
        svc.measureVersion(9999);
        throw new Error('应当抛错');
      } catch (e) {
        expect((e as ApiError).code).toBe('VERSION_NOT_FOUND');
        expect((e as ApiError).status).toBe(404);
      }
    } finally {
      cleanup();
    }
  });
});

describe('幂等、事务与持久化', () => {
  it('重复提交相同 idempotencyKey 返回同一链且不产生新步骤', () => {
    const { store, svc, cleanup } = fresh();
    try {
      const img = svc.importImage({
        name: 'a',
        matrix: toRows(ring(7, 7, 1, 1, 5, 5)),
        pixelHeight: 1,
        pixelWidth: 1,
        connectivity: 4,
      });
      const spec = {
        imageId: img.imageId,
        name: 'idem',
        idempotencyKey: 'key-123',
        steps: [{ op: 'dilate' as const, se: cross }],
      };
      const first = svc.runChain(spec);
      const second = svc.runChain(spec);
      expect(second.chainId).toBe(first.chainId);
      expect(store.listSteps(first.chainId)).toHaveLength(1);
      expect(store.listVersions(img.imageId, 100, 0).total).toBe(2);
    } finally {
      cleanup();
    }
  });

  it('操作链中途失败不留下指向缺失版本的脏步骤', () => {
    const { store, svc, cleanup } = fresh();
    try {
      const img = svc.importImage({
        name: 'a',
        matrix: [
          [1, 1, 1],
          [1, 1, 1],
          [1, 1, 1],
        ],
        pixelHeight: 1,
        pixelWidth: 1,
        connectivity: 8,
      });
      let err: unknown;
      try {
        svc.runChain({
          imageId: img.imageId,
          name: 'bad',
          steps: [
            { op: 'dilate', se: cross },
            { op: 'merge', params: { versionId: 999999 } },
          ],
        });
      } catch (e) {
        err = e;
      }
      expect((err as ApiError).code).toBe('MERGE_VERSION_NOT_FOUND');
      const badChain = store.listChains(img.imageId, 100, 0).rows.find((c) => c.name === 'bad')!;
      for (const s of store.listSteps(Number(badChain.id))) {
        expect(store.getVersion(Number(s.result_version_id))).not.toBeNull();
        expect(store.getVersion(Number(s.source_version_id))).not.toBeNull();
      }
    } finally {
      cleanup();
    }
  });

  it('单步事务原子回滚：外键失败时结果版本一并撤销', () => {
    const { store, svc, cleanup } = fresh();
    try {
      const img = svc.importImage({
        name: 'atom',
        matrix: [
          [1, 1],
          [1, 1],
        ],
        pixelHeight: 1,
        pixelWidth: 1,
      });
      const before = store.listVersions(img.imageId, 100, 0).total;
      expect(() =>
        store.addStep({
          chainId: 987654,
          imageId: img.imageId,
          op: 'dilate',
          params: {},
          sourceVersionId: img.versionId,
          resultMatrix: matrixFromRows([
            [1, 1],
            [1, 1],
          ]),
        }),
      ).toThrow();
      expect(store.listVersions(img.imageId, 100, 0).total).toBe(before);
    } finally {
      cleanup();
    }
  });

  it('重启后数据持久化，迁移可重复执行', () => {
    const { store, svc, path, cleanup } = fresh();
    try {
      const img = svc.importImage({
        name: 'persist',
        matrix: toRows(ring(7, 7, 2, 2, 4, 4)),
        pixelHeight: 2,
        pixelWidth: 3,
        unit: 'um',
        connectivity: 4,
      });
      const chain = svc.runChain({
        imageId: img.imageId,
        name: 'oc',
        steps: [
          { op: 'open', se: cross },
          { op: 'close', se: cross },
        ],
      });
      const reportBefore = svc.measureVersion(chain.steps[1].resultVersionId);
      store.close();

      const store2 = new Store(path);
      const svc2 = new MorphService(store2);
      expect(store2.getImage(img.imageId)?.name).toBe('persist');
      const reportAfter = svc2.measureVersion(chain.steps[1].resultVersionId);
      expect(reportAfter.foregroundPixelCount).toBe(reportBefore.foregroundPixelCount);
      expect(reportAfter.pixelWidth).toBe(3);
      expect(svc2.replayChain(chain.chainId).reproduced).toBe(true);
      store2.close();
    } finally {
      cleanup();
    }
  });
});

describe('分页查询', () => {
  it('listImages 分页与总数', () => {
    const { store, svc, cleanup } = fresh();
    try {
      for (let i = 0; i < 5; i++) {
        svc.importImage({ name: `img${i}`, matrix: [[1]], pixelHeight: 1, pixelWidth: 1 });
      }
      expect(store.listImages(2, 0).rows).toHaveLength(2);
      expect(store.listImages(2, 0).total).toBe(5);
      expect(store.listImages(2, 4).rows).toHaveLength(1);
    } finally {
      cleanup();
    }
  });
});
