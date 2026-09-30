// 只清理本项目的数据目录与临时文件，不触碰项目外任何进程或文件。
import { rmSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targets = [
  'data',
  'dist',
  'data/server.port',
];

for (const t of targets) {
  const p = resolve(root, t);
  if (!p.startsWith(root)) continue; // 安全护栏
  if (existsSync(p)) {
    rmSync(p, { recursive: true, force: true });
    console.log(`已删除 ${t}`);
  }
}
console.log('清理完成（仅本项目 data/ 与 dist/）');
