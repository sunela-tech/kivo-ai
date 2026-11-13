#!/usr/bin/env node
/**
 * Run the Kivo Worker locally when outbound traffic must go through an HTTPS proxy.
 *
 * `wrangler dev` is the normal way to run the API (npm run dev:api). The local
 * Workers runtime, however, connects directly and ignores HTTPS_PROXY, so in
 * proxied environments (cloud dev containers, some corporate networks) the
 * Worker cannot reach Clerk, Gemini or Meshy. This runner starts the same
 * bundled Worker with Miniflare and routes its outbound fetches through Node,
 * which does honour HTTPS_PROXY.
 *
 *   node scripts/dev-sandbox.mjs            # API on http://localhost:8787
 *
 * It uses the same local state directory, D1 migrations and .dev.vars as wrangler.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as miniflare from "miniflare";

const { Miniflare, Response, fetch } = miniflare;
import { ProxyAgent } from "undici";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const api = join(root, "apps", "api");
const port = Number(process.env.PORT ?? 8787);

function stripJsonComments(text) {
  return text.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1");
}
const config = JSON.parse(stripJsonComments(readFileSync(join(api, "wrangler.jsonc"), "utf8")));

function devVars() {
  const path = join(api, ".dev.vars");
  if (!existsSync(path)) return {};
  const vars = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/);
    if (m) vars[m[1]] = m[2];
  }
  return vars;
}

console.log("Bundling the Worker…");
const outdir = join(api, ".wrangler", "sandbox-bundle");
execFileSync("npx", ["wrangler", "deploy", "--dry-run", "--outdir", outdir], { cwd: api, stdio: ["ignore", "ignore", "inherit"] });

const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
const dispatcher = proxy ? new ProxyAgent({ uri: proxy }) : undefined;
const queue = config.queues.consumers[0];

const options = {
  name: config.name,
  modules: true,
  scriptPath: join(outdir, "index.js"),
  compatibilityDate: config.compatibility_date,
  compatibilityFlags: config.compatibility_flags,
  port,
  host: "127.0.0.1",
  log: new miniflare.Log(miniflare.LogLevel.INFO),
  bindings: { ...config.vars, ...devVars() },
  d1Persist: join(api, ".wrangler", "sandbox-state", "d1"),
  r2Persist: join(api, ".wrangler", "sandbox-state", "r2"),
  d1Databases: { DB: config.d1_databases[0].database_id },
  r2Buckets: { BUCKET: config.r2_buckets[0].bucket_name },
  queueProducers: { PIPELINE: { queueName: queue.queue } },
  queueConsumers: {
    [queue.queue]: { maxBatchSize: queue.max_batch_size, maxBatchTimeout: queue.max_batch_timeout, maxRetries: queue.max_retries, deadLetterQueue: queue.dead_letter_queue },
    [queue.dead_letter_queue]: { maxBatchSize: 10, maxBatchTimeout: 5 },
  },
  // Outbound requests leave through Node so HTTPS_PROXY and the system CA bundle apply.
  async outboundService(request) {
    try {
      const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
      const headers = new Headers(request.headers);
      headers.delete("host");
      const upstream = await fetch(request.url, { method: request.method, headers, body, dispatcher, redirect: "manual" });
      return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
    } catch (error) {
      return new Response(`outbound fetch failed: ${error?.cause?.code ?? error?.message ?? error}`, { status: 502 });
    }
  },
};
// Miniflare 5 takes a new options shape and ships a converter for the classic one; Miniflare 4 takes the classic shape directly.
const mf = new Miniflare(miniflare.convertV4MiniflareOptions ? miniflare.convertV4MiniflareOptions(options) : options);

const db = await mf.getD1Database("DB");
await db.exec("CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)");
const applied = new Set((await db.prepare("SELECT name FROM d1_migrations").all()).results.map((r) => r.name));
for (const file of readdirSync(join(api, "migrations")).filter((f) => f.endsWith(".sql")).sort()) {
  if (applied.has(file)) continue;
  const sql = readFileSync(join(api, "migrations", file), "utf8")
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
  for (const statement of sql.split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean)) await db.prepare(statement).run();
  await db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").bind(file).run();
  console.log(`Applied migration ${file}`);
}

await mf.ready;
console.log(`Kivo API ready on http://localhost:${port}${proxy ? " (outbound via HTTPS_PROXY)" : ""}`);

// Cron trigger: recover interrupted jobs once a minute, as in production.
const worker = await mf.getWorker();
const cron = setInterval(() => worker.scheduled({ cron: "* * * * *" }).catch((e) => console.error("scheduled failed:", e.message)), 60_000);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    clearInterval(cron);
    await mf.dispose();
    process.exit(0);
  });
}
