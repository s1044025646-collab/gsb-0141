/**
 * 可重复的端到端演示：使用注入的固定时钟，确定性生成合成矩阵，
 * 建库 -> 导入(含掩膜) -> 注册非对称结构元素 -> 执行开闭操作链 ->
 * 测量区域/孔洞 -> 比较前后 -> 过滤/合并 -> 导出标签 -> 历史复现。
 * 不监听端口、不联网；数据库写在 data/demo/ 下。
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from './db/store.js';
import { MorphService } from './service/service.js';
import { toRows } from './core/matrix.js';
import { StructElement } from './core/morphology.js';
import { diagonal, seededRng, saltNoise, rectMask, rect } from './core/synthetic.js';

const cross: StructElement = {
  name: 'demo-cross',
  shape: [
    [0, 1, 0],
    [1, 1, 1],
    [0, 1, 0],
  ],
  anchorRow: 1,
  anchorCol: 1,
};

const asym: StructElement = {
  name: 'demo-asym',
  shape: [
    [1, 1, 1],
    [0, 1, 0],
  ],
  anchorRow: 0,
  anchorCol: 0,
};

function main(): void {
  const dir = join(process.cwd(), 'data', 'demo');
  rmSync(dir, { recursive: true, force: true });
  const dbPath = join(dir, 'demo.db');
  // 注入固定时钟：时间戳确定、可复现
  let tick = 0;
  const clock = (): Date => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, tick++ * 1000));
  const store = new Store(dbPath, clock);
  const svc = new MorphService(store);

  console.log('=== 1. 合成矩阵（固定种子 RNG + 环形 + 对角线段）===');
  const rng = seededRng(42);
  // 实心 5x5 主体（内含一个小孔），叠加固定种子盐噪
  const base = rect(11, 11, 2, 2, 7, 7);
  base.data[5 * 11 + 4] = 0; // 打一个小孔
  const noise = saltNoise(11, 11, 0.1, rng);
  const ringM = base;
  for (let i = 0; i < noise.data.length; i++) ringM.data[i] = ringM.data[i] === 1 || noise.data[i] === 1 ? 1 : 0;
  const mask = rectMask(11, 11, 0, 0, 10, 10);
  console.log(`主体+盐噪前景像元: ${ringM.data.reduce((a, b) => a + b, 0)}（掩膜有效像元 ${mask.data.reduce((a, b) => a + b, 0)}）`);

  console.log('\n=== 2. 导入（像元 0.5mm x 0.5mm，前景 8 连通）===');
  const img = svc.importImage({
    name: 'demo-ring',
    matrix: toRows(ringM),
    mask: toRows(mask),
    pixelHeight: 0.5,
    pixelWidth: 0.5,
    unit: 'mm',
    connectivity: 8,
  });
  console.log(`imageId=${img.imageId} 原图版本 versionId=${img.versionId}`);

  console.log('\n=== 3. 操作链：开运算去盐噪（幂等键 demo-key）===');
  const chain = svc.runChain({
    imageId: img.imageId,
    name: 'denoise',
    idempotencyKey: 'demo-key',
    steps: [{ op: 'open', se: cross, name: '开运算(十字)' }],
  });
  const openedId = chain.steps[0].resultVersionId;
  // 重复提交验证幂等
  const again = svc.runChain({
    imageId: img.imageId,
    name: 'denoise',
    idempotencyKey: 'demo-key',
    steps: [{ op: 'open', se: cross }],
  });
  console.log(`链 ${chain.chainId}，重复提交复用同一链: ${again.chainId === chain.chainId}`);

  console.log('\n=== 4. 再用非对称 SE 闭运算（验证锚点/反射方向）===');
  const chain2 = svc.runChain({
    imageId: img.imageId,
    name: 'close-asym',
    startVersionId: openedId,
    steps: [{ op: 'close', se: asym, name: '闭运算(非对称)' }],
  });

  console.log('\n=== 5. 区域测量（物理面积与像元数分开）===');
  const report = svc.measureVersion(openedId);
  console.log(
    `连通 ${report.connectivity}/${report.backgroundConnectivity}，区域 ${report.regionCount}，孔洞 ${report.totalHoleCount}，欧拉 ${report.eulerNumber}`,
  );
  console.log(
    `前景 ${report.foregroundPixelCount} 像元 = ${report.foregroundArea} mm²，占有效区域 ${(report.foregroundFraction * 100).toFixed(1)}%`,
  );
  console.log(`边界策略: ${report.boundaryPolicy}`);
  for (const h of report.holes) {
    console.log(`孔洞 #${h.holeLabel} ${h.pixelCount} 像元/${h.area}mm² 定位(row=${h.anchor.row},col=${h.anchor.col})`);
  }

  console.log('\n=== 6. 比较处理前后 ===');
  const diff = svc.diffVersions(img.versionId, openedId);
  console.log(`开运算: 新增 ${diff.addedCount}，移除 ${diff.removedCount}，保持前景 ${diff.unchangedOnes}`);

  console.log('\n=== 7. 过滤（保留最大区域）+ 人工合并（并集回原图，生成新版本）===');
  const largest = [...report.regions].sort((a, b) => b.pixelCount - a.pixelCount)[0];
  const filtered = svc.runChain({
    imageId: img.imageId,
    name: 'keep-largest',
    startVersionId: openedId,
    steps: [{ op: 'filter', params: { keepLabels: [largest.label] } }],
  });
  const merged = svc.runChain({
    imageId: img.imageId,
    name: 'union-original',
    startVersionId: img.versionId,
    steps: [{ op: 'merge', params: { versionId: filtered.steps[0].resultVersionId } }],
  });
  console.log(`过滤版本=${filtered.steps[0].resultVersionId}，合并新版本=${merged.steps[0].resultVersionId}（原图 v1 未改）`);

  console.log('\n=== 8. 导出标签矩阵（8 连通）===');
  const labels = svc.exportLabels(openedId);
  console.log(`标签 ${labels.connectivity} 连通，标签行示例: ${JSON.stringify(labels.labels[4])}`);

  console.log('\n=== 9. 历史复现 ===');
  for (const id of [chain.chainId, chain2.chainId, filtered.chainId, merged.chainId]) {
    const r = svc.replayChain(id);
    console.log(`链 ${id}: ${r.reproduced ? '重算一致 ✓' : '不一致 ✗'}`);
  }

  console.log('\n=== 10. 全空/全满/对角 夹具快速自检 ===');
  const diag = diagonal(5, 5, 0, 4, 5, 1, -1);
  const d8 = svc.importImage({ name: 'diag', matrix: toRows(diag), pixelHeight: 1, pixelWidth: 1, connectivity: 8 });
  const d4 = svc.importImage({ name: 'diag4', matrix: toRows(diag), pixelHeight: 1, pixelWidth: 1, connectivity: 4 });
  console.log(`对角线段 8 连通区域=${svc.measureVersion(d8.versionId).regionCount}，4 连通区域=${svc.measureVersion(d4.versionId).regionCount}`);

  console.log(`\n演示完成，数据库: ${dbPath}`);
  store.close();
}

main();
