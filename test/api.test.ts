import { describe, it, expect, afterEach } from 'vitest';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, StartedServer } from '../src/api/server.js';
import { ring } from '../src/core/synthetic.js';
import { toRows } from '../src/core/matrix.js';

const TMP = mkdtempSync(join(tmpdir(), 'morph-test-api-'));
let server: StartedServer | null = null;

afterEach(async () => {
  if (server) {
    await server.close();
    server = null;
  }
  rmSync(TMP, { recursive: true, force: true });
});

async function boot(): Promise<StartedServer> {
  server = await startServer(join(TMP, `api-${Date.now()}-${Math.random().toString(36).slice(2)}.db`));
  return server;
}

async function call(
  s: StartedServer,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${s.port}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

describe('HTTP API 端到端', () => {
  it('只绑定本机，健康检查', async () => {
    const s = await boot();
    expect(s.port).toBeGreaterThan(0);
    const { status, json } = await call(s, 'GET', '/health');
    expect(status).toBe(200);
    expect(json.status).toBe('ok');
  });

  it('导入 -> 结构元素 -> 操作链 -> 区域 -> 标签 -> 比较 -> 复现 全链路', async () => {
    const s = await boot();
    const imported = await call(s, 'POST', '/images', {
      name: 'ring',
      matrix: toRows(ring(7, 7, 2, 2, 4, 4)),
      pixelHeight: 0.5,
      pixelWidth: 0.5,
      unit: 'mm',
      connectivity: 4,
    });
    expect(imported.status).toBe(201);
    const imageId = imported.json.imageId;

    await call(s, 'POST', '/struct-elements', {
      name: 'cross',
      shape: [
        [0, 1, 0],
        [1, 1, 1],
        [0, 1, 0],
      ],
      anchorRow: 1,
      anchorCol: 1,
    });

    const chain = await call(s, 'POST', '/chains/run', {
      imageId,
      name: 'oc',
      idempotencyKey: 'e2e-1',
      steps: [
        { op: 'open', se: { name: 'cross', shape: [[0, 1, 0], [1, 1, 1], [0, 1, 0]], anchorRow: 1, anchorCol: 1 } },
      ],
    });
    expect(chain.status).toBe(201);
    const resultVersionId = chain.json.steps[0].resultVersionId;

    // 幂等重复提交
    const again = await call(s, 'POST', '/chains/run', {
      imageId,
      name: 'oc',
      idempotencyKey: 'e2e-1',
      steps: [
        { op: 'open', se: { name: 'cross', shape: [[0, 1, 0], [1, 1, 1], [0, 1, 0]], anchorRow: 1, anchorCol: 1 } },
      ],
    });
    expect(again.json.chainId).toBe(chain.json.chainId);

    const regions = await call(s, 'GET', `/versions/${resultVersionId}/measure?connectivity=4`);
    expect(regions.status).toBe(200);
    expect(regions.json.boundaryPolicy).toContain('outside');
    expect(regions.json.pixelWidth).toBe(0.5);
    expect(regions.json.foregroundArea).toBeCloseTo(regions.json.foregroundPixelCount * 0.25, 10);

    const labels = await call(s, 'GET', `/versions/${resultVersionId}/labels`);
    expect(labels.json.labels.length).toBe(7);

    const diff = await call(s, 'GET', `/versions/diff?before=${imported.json.versionId}&after=${resultVersionId}`);
    expect(diff.status).toBe(200);
    expect(typeof diff.json.addedCount).toBe('number');

    const replay = await call(s, 'POST', `/chains/${chain.json.chainId}/replay`);
    expect(replay.json.reproduced).toBe(true);
  });

  it('失败路径：404、400、非法 JSON 均有错误码', async () => {
    const s = await boot();
    expect((await call(s, 'GET', '/images/999')).status).toBe(404);
    const bad = await call(s, 'POST', '/images', { name: 'x', matrix: [], pixelHeight: 1, pixelWidth: 1 });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe('INVALID_MATRIX');

    const res = await fetch(`http://127.0.0.1:${s.port}/images`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    const json = await res.json();
    expect(json.error.code).toBe('INVALID_JSON');
  });

  it('分页元数据', async () => {
    const s = await boot();
    for (let i = 0; i < 3; i++) {
      await call(s, 'POST', '/images', { name: `p${i}`, matrix: [[1]], pixelHeight: 1, pixelWidth: 1 });
    }
    const r = await call(s, 'GET', '/images?page=1&pageSize=2');
    expect(r.json.data).toHaveLength(2);
    expect(r.json.pagination.total).toBe(3);
    expect(r.json.pagination.totalPages).toBe(2);
  });
});
