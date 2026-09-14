/**
 * A third service, in a third language, added to test what it costs to GROW this project rather
 * than to stand it up. It reads the same Postgres the agent writes and serves aggregates — so it
 * is a SECOND consumer of the database, which is the shape that makes a dependency graph worth
 * drawing at all.
 *
 * Internal only: no public domain, reached from `web` over the private network.
 */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import pg from "pg";

const INSTANCE = randomUUID().slice(0, 8);
const PORT = Number(process.env.PORT ?? 3002);

// Same rule the Rust service learned: an EMPTY value is what a platform that failed to inject one
// produces, and it must not be mistaken for a deliberate choice of "no database".
const url = process.env.DATABASE_URL?.trim();
const pool = url ? new pg.Pool({ connectionString: url, max: 3 }) : undefined;

async function stats() {
  if (!pool) return { error: "DATABASE_URL is not set on this service" };
  const totals = await pool.query<{ status: string; n: string }>(
    `SELECT status, COUNT(*)::text AS n FROM run GROUP BY status ORDER BY status`,
  );
  const models = await pool.query<{ model: string | null; n: string }>(
    `SELECT model, COUNT(*)::text AS n FROM run GROUP BY model ORDER BY n DESC`,
  );
  return {
    byStatus: Object.fromEntries(totals.rows.map((r) => [r.status, Number(r.n)])),
    // A null model is a row written before that column existed. It is reported as its own bucket
    // rather than folded into a total, because "not recorded" is not a value.
    byModel: models.rows.map((r) => ({ model: r.model ?? "(not recorded)", runs: Number(r.n) })),
  };
}

createServer(async (req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  try {
    if (path === "/health") return send(200, { ok: true, instance: INSTANCE, db: Boolean(pool) });
    if (path === "/stats") return send(200, { instance: INSTANCE, ...(await stats()) });
    send(404, { error: "not found" });
  } catch (err) {
    send(500, { error: err instanceof Error ? err.message : String(err) });
  }
  // Bind :: for the same reason the Rust service does: correct on both dual-stack and legacy
  // IPv6-only Railway environments, and a container cannot bind :: and 0.0.0.0 at once.
}).listen(PORT, "::", () => console.log(`[stats ${INSTANCE}] listening on [::]:${PORT}`));
