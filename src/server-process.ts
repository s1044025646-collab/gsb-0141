import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { startServer } from "./server.ts";

const ROOT = resolve(import.meta.dirname, "..");

startServer({
  dbPath: resolve(ROOT, "data/app.sqlite"),
}).then(({ port }) => {
  writeFileSync(resolve(ROOT, "data/server.port"), String(port));
  console.log(`morph backend listening on http://127.0.0.1:${port}`);
});
