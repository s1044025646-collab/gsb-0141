import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { openDatabase } from "./db.ts";
import { MorphService } from "./service.ts";
import { ApiError } from "./errors.ts";
import { resolve } from "node:path";

export interface StartOptions {
  dbPath?: string;
  port?: number;
  host?: string;
  clock?: { now(): number };
}

export interface StartedServer {
  server: Server;
  port: number;
  service: MorphService;
}

const DEFAULT_DB = resolve("data/app.sqlite");

export async function startServer(opts: StartOptions = {}): Promise<StartedServer> {
  const host = opts.host ?? "127.0.0.1";
  const db = openDatabase(opts.dbPath ?? DEFAULT_DB);
  const service = new MorphService(db, opts.clock);
  const server = createServer((req, res) => handle(req, res, service));
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    // port 0 => OS-assigned free port (auto port), always loopback only.
    server.listen(opts.port ?? 0, host, () => done());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to bind server");
  return { server, port: address.port, service };
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiError("VALIDATION_ERROR", "request body must be valid JSON");
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(json),
  });
  res.end(json);
}

function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof ApiError) {
    const status =
      err.code === "NOT_FOUND" ? 404 : err.code === "CONFLICT" ? 409 : err.code === "UNSUPPORTED_OP" ? 400 : 400;
    send(res, status, { error: { code: err.code, message: err.message } });
    return;
  }
  send(res, 500, { error: { code: "INTERNAL", message: (err as Error).message } });
}

function paginate(url: URL): { page: number; pageSize: number } {
  const page = Math.max(0, Number(url.searchParams.get("page") ?? "0") || 0);
  const pageSizeRaw = Number(url.searchParams.get("pageSize") ?? "50");
  const pageSize = Math.min(200, Math.max(1, pageSizeRaw || 50));
  return { page, pageSize };
}

async function handle(req: IncomingMessage, res: ServerResponse, service: MorphService): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;
  try {
    if (req.method === "GET" && path === "/health") {
      send(res, 200, { ok: true });
      return;
    }
    if (req.method === "POST" && path === "/images") {
      const body = (await readJson(req)) as { name?: string; payload?: unknown };
      if (typeof body.name !== "string" || body.name.length === 0) {
        throw new ApiError("VALIDATION_ERROR", "name required");
      }
      const out = service.importImage({ name: body.name, payload: body.payload as never });
      send(res, 201, out);
      return;
    }
    if (req.method === "POST" && path === "/structuring-elements") {
      const body = (await readJson(req)) as { name?: string; shape?: unknown; anchor?: [number, number] };
      if (typeof body.name !== "string" || !Array.isArray(body.shape)) {
        throw new ApiError("VALIDATION_ERROR", "name and shape required");
      }
      service.registerSE({ name: body.name, shape: body.shape as never, anchor: body.anchor });
      send(res, 201, { ok: true });
      return;
    }
    const chainMatch = path.match(/^\/images\/(\d+)\/chains$/);
    if (req.method === "POST" && chainMatch) {
      const body = (await readJson(req)) as Record<string, unknown>;
      const out = service.runChain({
        imageId: Number(chainMatch[1]),
        sourceVersionId: Number(body.sourceVersionId),
        steps: body.steps as never,
        idempotencyKey: body.idempotencyKey as string | undefined,
      });
      send(res, 201, out);
      return;
    }
    const regionsMatch = path.match(/^\/chains\/(\d+)\/regions$/);
    if (req.method === "GET" && regionsMatch) {
      const { page, pageSize } = paginate(url);
      send(res, 200, service.listRegions(Number(regionsMatch[1]), page, pageSize));
      return;
    }
    const holesMatch = path.match(/^\/chains\/(\d+)\/holes$/);
    if (req.method === "GET" && holesMatch) {
      const report = service.getReport(Number(holesMatch[1]));
      const { page, pageSize } = paginate(url);
      const items = report?.holes ?? [];
      send(res, 200, {
        total: items.length,
        page,
        pageSize,
        items: items.slice(page * pageSize, page * pageSize + pageSize),
      });
      return;
    }
    const labelsMatch = path.match(/^\/chains\/(\d+)\/labels$/);
    if (req.method === "GET" && labelsMatch) {
      const report = service.getReport(Number(labelsMatch[1]));
      send(res, 200, { labels: report?.labels ?? [] });
      return;
    }
    const versionsMatch = path.match(/^\/images\/(\d+)\/versions$/);
    if (req.method === "GET" && versionsMatch) {
      send(res, 200, { items: service.listVersions(Number(versionsMatch[1])) });
      return;
    }
    if (req.method === "GET" && path === "/versions/compare") {
      const a = Number(url.searchParams.get("a"));
      const b = Number(url.searchParams.get("b"));
      if (!Number.isInteger(a) || !Number.isInteger(b)) {
        throw new ApiError("VALIDATION_ERROR", "a and b version ids required");
      }
      send(res, 200, service.compareVersions(a, b));
      return;
    }
    if (req.method === "GET" && path.match(/^\/versions\/\d+\/matrix$/)) {
      const id = Number(path.split("/")[2]);
      send(res, 200, service.getVersionMatrix(id));
      return;
    }
    send(res, 404, { error: { code: "NOT_FOUND", message: "no such route" } });
  } catch (err) {
    sendError(res, err);
  }
}

const invoked = process.argv[1] && process.argv[1].endsWith("server.ts");
if (invoked) {
  startServer().then(({ port }) => {
    console.log(`morph backend listening on http://127.0.0.1:${port}`);
  });
}
