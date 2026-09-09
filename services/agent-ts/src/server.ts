/**
 * The agent service's HTTP face. Internal on BOTH platforms -- on Vercel by omitting it from the
 * top-level rewrites, on Railway by attaching no public domain.
 *
 * POST /runs        create a run, return its id immediately. Never awaits the agent.
 * GET  /runs/:id    the run plus its events after ?after=<seq>
 * POST /drain       VERCEL arm: claim and run ONE run, driven by cron. The container has no life
 *                   of its own, so something outside it has to provide the heartbeat.
 */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { claimNextRun, createRun, readRun, requeueStaleRuns } from "./store.js";
import { runAgent } from "./agent.js";

const PORT = Number(process.env.PORT ?? 3001);

const json = (res: any, code: number, body: unknown) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  try {
    if (req.method === "POST" && url.pathname === "/runs") {
      const body = await new Promise<string>((r) => {
        let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => r(d));
      });
      const { question } = JSON.parse(body || "{}");
      if (!question) return json(res, 400, { error: "question is required" });
      return json(res, 201, await createRun(question));
    }

    const match = /^\/runs\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (req.method === "GET" && match) {
      const after = Number(url.searchParams.get("after") ?? 0);
      const found = await readRun(match[1], after);
      return found.run ? json(res, 200, found) : json(res, 404, { error: "no such run" });
    }

    if (req.method === "POST" && url.pathname === "/drain") {
      await requeueStaleRuns();
      const run = await claimNextRun(`vercel-${randomUUID().slice(0, 8)}`);
      if (!run) return json(res, 200, { claimed: null });   // no work is not a failure
      await runAgent(run);
      return json(res, 200, { claimed: run.id });
    }

    json(res, 404, { error: "not found" });
  } catch (err) {
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}).listen(PORT, () => console.log(`[agent] listening on ${PORT}`));
