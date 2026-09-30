import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { writeFileSync } from 'node:fs';
import { MorphService, ApiError } from '../service/service.js';
import { Store } from '../db/store.js';

export interface StartedServer {
  server: Server;
  port: number;
  store: Store;
  close: () => Promise<void>;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
  });
  res.end(json);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 16 * 1024 * 1024) {
        reject(new ApiError('PAYLOAD_TOO_LARGE', '请求体超过 16MB', 413));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new ApiError('INVALID_JSON', '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function pageParams(url: URL): { limit: number; offset: number } {
  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(url.searchParams.get('pageSize') ?? '50', 10) || 50));
  return { limit: pageSize, offset: (page - 1) * pageSize };
}

function paged(res: ServerResponse, result: { rows: unknown[]; total: number }, page: number, pageSize: number): void {
  send(res, 200, {
    data: result.rows,
    pagination: {
      page,
      pageSize,
      total: result.total,
      totalPages: Math.max(1, Math.ceil(result.total / pageSize)),
    },
  });
}

export function createApp(service: MorphService): Server {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname.replace(/\/+$/, '') || '/';

      if (req.method === 'GET' && path === '/health') {
        send(res, 200, { status: 'ok' });
        return;
      }

      // 结构元素管理
      if (req.method === 'POST' && path === '/struct-elements') {
        const body = (await readBody(req)) as Record<string, unknown>;
        const id = service.store.upsertStructElement({
          name: String(body.name ?? ''),
          shape: body.shape as number[][],
          anchorRow: Number(body.anchorRow),
          anchorCol: Number(body.anchorCol),
        });
        send(res, 201, { id });
        return;
      }
      if (req.method === 'GET' && path === '/struct-elements') {
        send(res, 200, { data: service.store.listStructElements() });
        return;
      }

      // 图像
      if (req.method === 'POST' && path === '/images') {
        const body = (await readBody(req)) as Record<string, unknown>;
        const result = service.importImage({
          name: String(body.name ?? ''),
          matrix: body.matrix as number[][],
          mask: (body.mask as number[][] | null) ?? null,
          pixelHeight: Number(body.pixelHeight),
          pixelWidth: Number(body.pixelWidth),
          unit: (body.unit as string | null) ?? null,
          connectivity: body.connectivity === 4 ? 4 : 8,
        });
        send(res, 201, result);
        return;
      }
      if (req.method === 'GET' && path === '/images') {
        const { limit, offset } = pageParams(url);
        const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
        const pageSize = limit;
        paged(res, service.store.listImages(limit, offset), page, pageSize);
        return;
      }

      const imgMatch = path.match(/^\/images\/(\d+)$/);
      if (req.method === 'GET' && imgMatch) {
        const img = service.store.getImage(Number(imgMatch![1]));
        if (!img) throw new ApiError('IMAGE_NOT_FOUND', '图像不存在', 404);
        send(res, 200, img);
        return;
      }
      const verMatch = path.match(/^\/images\/(\d+)\/versions$/);
      if (req.method === 'GET' && verMatch) {
        const { limit, offset } = pageParams(url);
        const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
        paged(res, service.store.listVersions(Number(verMatch![1]), limit, offset), page, limit);
        return;
      }
      const chainListMatch = path.match(/^\/images\/(\d+)\/chains$/);
      if (req.method === 'GET' && chainListMatch) {
        const { limit, offset } = pageParams(url);
        const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
        paged(res, service.store.listChains(Number(chainListMatch![1]), limit, offset), page, limit);
        return;
      }

      // 操作链
      if (req.method === 'POST' && path === '/chains/run') {
        const body = (await readBody(req)) as Record<string, unknown>;
        const result = service.runChain({
          imageId: Number(body.imageId),
          name: String(body.name ?? 'chain'),
          startVersionId: body.startVersionId != null ? Number(body.startVersionId) : undefined,
          idempotencyKey: (body.idempotencyKey as string) ?? undefined,
          steps: (body.steps as never[]) ?? [],
        });
        send(res, 201, result);
        return;
      }
      const chainGet = path.match(/^\/chains\/(\d+)$/);
      if (req.method === 'GET' && chainGet) {
        const steps = service.store.listSteps(Number(chainGet![1]));
        if (steps.length === 0) throw new ApiError('CHAIN_NOT_FOUND', '操作链不存在', 404);
        send(res, 200, { chainId: Number(chainGet![1]), steps });
        return;
      }
      const replayMatch = path.match(/^\/chains\/(\d+)\/replay$/);
      if (req.method === 'POST' && replayMatch) {
        send(res, 200, service.replayChain(Number(replayMatch![1])));
        return;
      }

      // 版本测量 / 区域 / 孔洞 / 比较 / 导出标签
      const measureMatch = path.match(/^\/versions\/(\d+)\/measure$/);
      if (req.method === 'GET' && measureMatch) {
        const connParam = url.searchParams.get('connectivity');
        const conn = connParam === '4' ? 4 : connParam === '8' ? 8 : undefined;
        const report = service.measureVersion(Number(measureMatch![1]), conn);
        const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
        const pageSize = Math.min(200, Math.max(1, parseInt(url.searchParams.get('pageSize') ?? '50', 10) || 50));
        const start = (page - 1) * pageSize;
        send(res, 200, {
          ...report,
          regions: report.regions.slice(start, start + pageSize),
          pagination: {
            page,
            pageSize,
            total: report.regions.length + report.holes.length,
            regionTotal: report.regionCount,
            holeTotal: report.totalHoleCount,
            totalPages: Math.max(1, Math.ceil(report.regionCount / pageSize)),
          },
        });
        return;
      }
      const holesMatch = path.match(/^\/versions\/(\d+)\/holes$/);
      if (req.method === 'GET' && holesMatch) {
        const report = service.measureVersion(Number(holesMatch![1]));
        send(res, 200, { data: report.holes, total: report.totalHoleCount });
        return;
      }
      const labelsMatch = path.match(/^\/versions\/(\d+)\/labels$/);
      if (req.method === 'GET' && labelsMatch) {
        const connParam = url.searchParams.get('connectivity');
        const conn = connParam === '4' ? 4 : connParam === '8' ? 8 : undefined;
        send(res, 200, service.exportLabels(Number(labelsMatch![1]), conn));
        return;
      }
      if (req.method === 'GET' && path === '/versions/diff') {
        const before = Number(url.searchParams.get('before'));
        const after = Number(url.searchParams.get('after'));
        if (!Number.isInteger(before) || !Number.isInteger(after)) {
          throw new ApiError('INVALID_QUERY', '需要 before 与 after 版本 id');
        }
        const width = service.store.getVersion(before)?.matrix_json
          ? (JSON.parse(service.store.getVersion(before)!.matrix_json) as number[][])[0].length
          : 0;
        const d = service.diffVersions(before, after);
        send(res, 200, {
          addedCount: d.addedCount,
          removedCount: d.removedCount,
          unchangedOnes: d.unchangedOnes,
          added: d.added.slice(0, 500).map((i) => ({ row: Math.floor(i / width), col: i % width })),
          removed: d.removed.slice(0, 500).map((i) => ({ row: Math.floor(i / width), col: i % width })),
          truncated: d.added.length > 500 || d.removed.length > 500,
        });
        return;
      }

      send(res, 404, { error: { code: 'NOT_FOUND', message: '未知路由' } });
    } catch (err) {
      if (err instanceof ApiError) {
        send(res, err.status, { error: { code: err.code, message: err.message } });
      } else {
        send(res, 500, { error: { code: 'INTERNAL', message: (err as Error).message } });
      }
    }
  });
  return server;
}

export function startServer(dbPath: string, opts?: { port?: number; portFile?: string; clock?: () => Date }): Promise<StartedServer> {
  const store = new Store(dbPath, opts?.clock);
  const service = new MorphService(store);
  const server = createApp(service);
  return new Promise((resolve) => {
    server.listen(opts?.port ?? 0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      if (opts?.portFile) writeFileSync(opts.portFile, String(port), 'utf-8');
      resolve({
        server,
        port,
        store,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => {
              store.close();
              r();
            });
          }),
      });
    });
  });
}
