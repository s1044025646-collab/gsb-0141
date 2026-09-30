#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store } from '../db/store.js';
import { MorphService } from '../service/service.js';

import { StructElement } from '../core/morphology.js';

function usage(): never {
  console.error(
    [
      '用法: morph-cli <命令> [参数]',
      '全局: --db <path>          SQLite 路径 (默认 ./data/morph.db)',
      '',
      '命令:',
      '  import <name> <matrix.json> [--mask m.json] [--pixel-h 0.1] [--pixel-w 0.1] [--unit um] [--conn 8]',
      '  images [--page 1] [--page-size 50]',
      '  versions <imageId>',
      '  se <name> <shape.json> <anchorRow> <anchorCol>',
      '  chain <imageId> <chain.json>          JSON: {name, steps:[{op,se:{name,shape,anchorRow,anchorCol},params}]}',
      '  regions <versionId> [--conn 8]',
      '  holes <versionId>',
      '  diff <beforeVersionId> <afterVersionId>',
      '  labels <versionId> [--conn 8] [--out file.json]',
      '  replay <chainId>',
      '  show <versionId>                      打印 0/1 矩阵',
    ].join('\n'),
  );
  process.exit(2);
}

function parseArgs(argv: string[]): { positional: string[]; flags: Map<string, string> } {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags.set(key, 'true');
      else {
        flags.set(key, next);
        i++;
      }
    } else positional.push(a);
  }
  return { positional, flags };
}

function readJson(path: string): unknown {
  if (!existsSync(path)) {
    console.error(`文件不存在: ${path}`);
    process.exit(2);
  }
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function draw(rows: number[][]): string {
  return rows.map((r) => r.map((v) => (v === 0 ? '·' : '█')).join(' ')).join('\n');
}

export async function main(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const command = positional.shift();
  if (!command) usage();
  const dbPath = resolve(flags.get('db') ?? 'data/morph.db');
  const store = new Store(dbPath);
  const svc = new MorphService(store);

  try {
    switch (command) {
      case 'import': {
        const [name, file] = positional;
        if (!name || !file) usage();
        const matrix = readJson(file) as number[][];
        const maskFile = flags.get('mask');
        const res = svc.importImage({
          name,
          matrix,
          mask: maskFile ? (readJson(maskFile) as number[][]) : null,
          pixelHeight: Number(flags.get('pixel-h') ?? 1),
          pixelWidth: Number(flags.get('pixel-w') ?? 1),
          unit: flags.get('unit') ?? null,
          connectivity: Number(flags.get('conn') ?? 8) === 4 ? 4 : 8,
        });
        const ones = matrix.flat().filter((v) => v === 1).length;
        console.log(`导入前: 矩阵 ${matrix[0].length}x${matrix.length}, 前景 ${ones} 像元`);
        console.log(`导入后: imageId=${res.imageId} version=1 (versionId=${res.versionId})`);
        return 0;
      }
      case 'images': {
        const page = Number(flags.get('page') ?? 1);
        const pageSize = Number(flags.get('page-size') ?? 50);
        const { rows, total } = store.listImages(pageSize, (page - 1) * pageSize);
        for (const r of rows) {
          console.log(`#${r.id} ${r.name} ${r.width}x${r.height} conn=${r.connectivity} px=${r.pixel_width}x${r.pixel_height}${r.unit ?? ''}`);
        }
        console.log(`-- 共 ${total} 张, 第 ${page}/${Math.max(1, Math.ceil(total / pageSize))} 页`);
        return 0;
      }
      case 'versions': {
        const imageId = Number(positional[0]);
        const { rows, total } = store.listVersions(imageId, 200, 0);
        for (const v of rows) {
          console.log(`versionId=${v.id} v${v.version} [${v.kind}] ${v.note ?? ''}`);
        }
        console.log(`-- 共 ${total} 个版本`);
        return 0;
      }
      case 'se': {
        const [name, file, ar, ac] = positional;
        const shape = readJson(file) as number[][];
        const se: StructElement = { name, shape, anchorRow: Number(ar), anchorCol: Number(ac) };
        const id = store.upsertStructElement(se);
        console.log(`结构元素 ${name} 已保存 (id=${id}), 锚点=(${ar},${ac})`);
        console.log(draw(shape));
        return 0;
      }
      case 'chain': {
        const [imageIdStr, file] = positional;
        const imageId = Number(imageIdStr);
        const spec = readJson(file) as {
          name: string;
          steps: Array<{ op: string; se?: StructElement; params?: Record<string, unknown> }>;
          idempotencyKey?: string;
        };
        const before = store.latestVersion(imageId);
        const beforeRows = JSON.parse(before.matrix_json) as number[][];
        const beforeOnes = beforeRows.flat().filter((v) => v === 1).length;
        console.log(`步骤前: versionId=${before.id}, 前景 ${beforeOnes} 像元`);
        const res = svc.runChain({
          imageId,
          name: spec.name,
          idempotencyKey: spec.idempotencyKey,
          steps: spec.steps as never[],
        });
        for (const st of res.steps) {
          const row = store.getVersion(st.resultVersionId)!;
          const ones = (JSON.parse(row.matrix_json) as number[][]).flat().filter((v) => v === 1).length;
          console.log(`步骤 ${st.stepNo}: -> v${st.version} (versionId=${st.resultVersionId}), 前景 ${ones} 像元`);
        }
        return 0;
      }
      case 'regions': {
        const versionId = Number(positional[0]);
        const conn = Number(flags.get('conn') ?? 0);
        const report = svc.measureVersion(versionId, conn === 4 ? 4 : conn === 8 ? 8 : undefined);
        console.log(
          `尺寸 ${report.width}x${report.height} 前景连通=${report.connectivity} 背景连通=${report.backgroundConnectivity}`,
        );
        console.log(`有效像元 ${report.validPixelCount} (面积 ${report.validArea}), 前景 ${report.foregroundPixelCount} (面积 ${report.foregroundArea}), 占比 ${report.foregroundFraction.toFixed(4)}`);
        console.log(`区域 ${report.regionCount}, 孔洞 ${report.totalHoleCount}, 欧拉数 ${report.eulerNumber}`);
        for (const r of report.regions) {
          console.log(
            `区域 #${r.label} 像元=${r.pixelCount} 面积=${r.area} 质心=(${r.centroidRow.toFixed(2)},${r.centroidCol.toFixed(2)}) ` +
              `bbox=[r${r.bbox.minRow}-${r.bbox.maxRow},c${r.bbox.minCol}-${r.bbox.maxCol}] 孔洞=${r.holeCount} 欧拉=${r.eulerNumber} 触边=${r.touchesBorder}`,
          );
        }
        return 0;
      }
      case 'holes': {
        const versionId = Number(positional[0]);
        const report = svc.measureVersion(versionId);
        if (report.holes.length === 0) console.log('无孔洞');
        for (const h of report.holes) {
          console.log(
            `孔洞 #${h.holeLabel} 像元=${h.pixelCount} 面积=${h.area} 定位=(row=${h.anchor.row},col=${h.anchor.col}) ` +
              `包围区域=${h.surroundingLabels.join(',')} bbox=[r${h.bbox.minRow}-${h.bbox.maxRow},c${h.bbox.minCol}-${h.bbox.maxCol}]`,
          );
        }
        return 0;
      }
      case 'diff': {
        const [b, a] = positional.map(Number);
        const d = svc.diffVersions(b, a);
        console.log(`新增(0->1)=${d.addedCount} 消失(1->0)=${d.removedCount} 保持前景=${d.unchangedOnes}`);
        const ver = store.getVersion(b)!;
        const w = (JSON.parse(ver.matrix_json) as number[][])[0].length;
        const coords = (arr: number[]) => arr.slice(0, 20).map((i) => `(${Math.floor(i / w)},${i % w})`).join(' ');
        if (d.added.length) console.log(`新增坐标: ${coords(d.added)}${d.added.length > 20 ? ' ...' : ''}`);
        if (d.removed.length) console.log(`消失坐标: ${coords(d.removed)}${d.removed.length > 20 ? ' ...' : ''}`);
        return 0;
      }
      case 'labels': {
        const versionId = Number(positional[0]);
        const conn = Number(flags.get('conn') ?? 0);
        const exported = svc.exportLabels(versionId, conn === 4 ? 4 : conn === 8 ? 8 : undefined);
        if (flags.get('out')) writeFileSync(flags.get('out')!, JSON.stringify(exported.labels), 'utf-8');
        else console.log(draw(exported.labels) + `\n连通性=${exported.connectivity}`);
        return 0;
      }
      case 'replay': {
        const chainId = Number(positional[0]);
        const r = svc.replayChain(chainId);
        console.log(`历史复现: ${r.reproduced ? '一致 ✓' : '不一致 ✗'}，共 ${r.matrices.length} 个中间矩阵`);
        return r.reproduced ? 0 : 1;
      }
      case 'show': {
        const v = store.getVersion(Number(positional[0]));
        if (!v) {
          console.error('版本不存在');
          return 1;
        }
        console.log(draw(JSON.parse(v.matrix_json) as number[][]));
        return 0;
      }
      default:
        usage();
    }
  } catch (err) {
    const code = (err as { code?: string }).code;
    console.error(`错误 [${code ?? 'ERROR'}]: ${(err as Error).message}`);
    return 1;
  } finally {
    store.close();
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
