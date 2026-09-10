/**
 * RAILWAY ONLY. An always-on poll loop. This cannot exist on Vercel: a container with no inbound
 * traffic scales down after 5 minutes, and a setInterval is not traffic.
 *
 * No HTTP server, no port, no public domain -- so there is nothing to authenticate and nothing to
 * attack. That is the point of the arm.
 */
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { claimNextRun, requeueStaleRuns } from "./store.js";
import { runAgent } from "./agent.js";

/**
 * A worker that listens is a contradiction on Railway and a REQUIREMENT on Cloud Run and Azure
 * Container Apps: both gate a container's start on a successful HTTP probe against $PORT, so a
 * process with no listener never reaches "ready" and is killed as a failed revision -- with an error
 * that talks about the port and says nothing about the loop below.
 *
 * So: open a health endpoint only when the platform asks for one by setting PORT. Railway sets no
 * PORT for a service with no domain, and this stays a pure worker there.
 */
const port = process.env.PORT;
if (port) {
  createServer((_req, res) => { res.writeHead(200); res.end("ok"); }).listen(Number(port), () =>
    console.log(`[worker] health endpoint on ${port} (required by this platform's startup probe)`),
  );
}

const WORKER_ID = process.env.RAILWAY_REPLICA_ID ?? randomUUID().slice(0, 8);
const IDLE_MS = Number(process.env.POLL_IDLE_MS ?? 2000);

let stopping = false;
const controller = new AbortController();
process.on("SIGTERM", () => { stopping = true; controller.abort(); });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log(`[worker ${WORKER_ID}] polling every ${IDLE_MS}ms`);

while (!stopping) {
  try {
    const requeued = await requeueStaleRuns();
    if (requeued) console.log(`[worker ${WORKER_ID}] requeued ${requeued} stale run(s)`);

    const run = await claimNextRun(WORKER_ID);
    if (!run) { await sleep(IDLE_MS); continue; }

    console.log(`[worker ${WORKER_ID}] claimed ${run.id} (attempt ${run.attempt})`);
    await runAgent(run, controller.signal);
    console.log(`[worker ${WORKER_ID}] finished ${run.id}`);
  } catch (err) {
    console.error(`[worker ${WORKER_ID}]`, err);
    await sleep(IDLE_MS);
  }
}
console.log(`[worker ${WORKER_ID}] stopped`);
