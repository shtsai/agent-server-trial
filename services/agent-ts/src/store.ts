import { db } from "./db.js";

export type Run = {
  id: string; question: string; status: string;
  answer: string | null; error: string | null; attempt: number;
};

export async function createRun(question: string): Promise<Run> {
  const { rows } = await db().query<Run>(
    `INSERT INTO run (question) VALUES ($1) RETURNING id, question, status, answer, error, attempt`,
    [question],
  );
  return rows[0];
}

/**
 * Claim at the START of the work, not report at the end -- and derive the reply from the row the
 * UPDATE actually wrote, or a concurrent claimant's rows still read as free.
 *
 * FOR UPDATE SKIP LOCKED is the reason this is a real queue and not a race: a second worker skips
 * the locked row instead of blocking on it. SQLite has no equivalent, which is the single biggest
 * reason this trial runs on Postgres.
 */
export async function claimNextRun(workerId: string): Promise<Run | undefined> {
  const { rows } = await db().query<Run>(
    `UPDATE run SET status = 'running', worker_id = $1, attempt = attempt + 1,
            started_at = now(), heartbeat_at = now()
       WHERE id = (SELECT id FROM run WHERE status = 'queued'
                    ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
   RETURNING id, question, status, answer, error, attempt`,
    [workerId],
  );
  return rows[0];
}

export async function heartbeat(runId: string) {
  await db().query(`UPDATE run SET heartbeat_at = now() WHERE id = $1`, [runId]);
}

/** Terminal states stay DISTINCT. Collapsing 'partial' into 'done' makes the system lie. */
export async function finishRun(
  runId: string,
  status: "done" | "partial" | "failed" | "cancelled",
  fields: { answer?: string; error?: string } = {},
) {
  await db().query(
    `UPDATE run SET status = $2, answer = COALESCE($3, answer), error = $4, finished_at = now()
      WHERE id = $1`,
    [runId, status, fields.answer ?? null, fields.error ?? null],
  );
}

/** A run whose worker died mid-flight. The attempt counter is what stops this looping forever. */
export async function requeueStaleRuns(staleSeconds = 90, maxAttempts = 3): Promise<number> {
  const { rowCount } = await db().query(
    `UPDATE run SET status = CASE WHEN attempt >= $2 THEN 'failed' ELSE 'queued' END,
            error = CASE WHEN attempt >= $2 THEN 'worker died, attempts exhausted' ELSE error END
      WHERE status = 'running' AND heartbeat_at < now() - ($1 || ' seconds')::interval`,
    [staleSeconds, maxAttempts],
  );
  return rowCount ?? 0;
}

export async function appendEvent(runId: string, kind: string, payload: string) {
  await db().query(
    `INSERT INTO run_event (run_id, seq, kind, payload)
     VALUES ($1, (SELECT COALESCE(MAX(seq), 0) + 1 FROM run_event WHERE run_id = $1), $2, $3)`,
    [runId, kind, payload],
  );
}

export async function readRun(runId: string, afterSeq = 0) {
  const run = await db().query(`SELECT * FROM run WHERE id = $1`, [runId]);
  const events = await db().query(
    `SELECT seq, kind, payload FROM run_event WHERE run_id = $1 AND seq > $2 ORDER BY seq`,
    [runId, afterSeq],
  );
  return { run: run.rows[0], events: events.rows };
}
