/**
 * RAILWAY ONLY. An always-on poll loop. This cannot exist on Vercel: a container with no inbound
 * traffic scales down after 5 minutes, and a setInterval is not traffic.
 *
 * No HTTP server, no port, no public domain -- so there is nothing to authenticate and nothing to
 * attack. That is the point of the arm.
 */
import { randomUUID } from "node:crypto";
import { claimNextRun, requeueStaleRuns } from "./store.js";
import { runAgent } from "./agent.js";

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
