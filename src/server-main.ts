import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { startServer } from './api/server.js';

/**
 * 启动：只绑定 127.0.0.1，端口 0 = 由系统自动分配；
 * 数据与端口文件全部写在本项目 data/ 下。
 */
async function run(): Promise<void> {
  const dbPath = resolve(process.env.MORPH_DB ?? 'data/morph.db');
  const portFile = process.env.MORPH_PORT_FILE ?? 'data/server.port';
  mkdirSync('data', { recursive: true });
  const started = await startServer(dbPath, { portFile });
  writeFileSync('data/server.pid', String(process.pid), 'utf-8');
  console.log(`形态学后端已启动: http://127.0.0.1:${started.port} (db=${dbPath})`);
  console.log('按 Ctrl+C 停止');
  const shutdown = (): void => {
    void started.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void run();
