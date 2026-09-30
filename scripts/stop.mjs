// 停止由本项目启动的后端：读取 data/server.port，仅访问 127.0.0.1 本机端口，
// 通过 /health 确认是本服务后，结束记录在 data/server.pid 的、命令行含 src/server-main.ts 的本项目进程。
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const portFile = resolve(root, 'data', 'server.port');
const pidFile = resolve(root, 'data', 'server.pid');

async function isOurs(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
    const body = await res.json();
    return body.status === 'ok';
  } catch {
    return false;
  }
}

async function main() {
  let stopped = false;
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, 'utf-8').trim());
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 'SIGTERM');
        console.log(`已发送停止信号给本项目服务进程 PID=${pid}`);
        stopped = true;
      } catch {
        /* 进程已退出 */
      }
    }
    rmSync(pidFile, { force: true });
  } else if (existsSync(portFile)) {
    const port = Number(readFileSync(portFile, 'utf-8').trim());
    if (Number.isInteger(port) && (await isOurs(port))) {
      // 通过端口找到监听 PID（仅本机）
      try {
        const out = execFileSync('powershell', [
          '-NoProfile',
          '-Command',
          `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess`,
        ])
          .toString()
          .trim();
        const pid = Number(out.split(/\s+/)[0]);
        if (pid > 0) {
          process.kill(pid, 'SIGTERM');
          console.log(`已停止监听 127.0.0.1:${port} 的本项目进程 PID=${pid}`);
          stopped = true;
        }
      } catch {
        /* ignore */
      }
    }
  }
  if (!stopped) console.log('未发现运行中的本项目服务。');
}

main();
