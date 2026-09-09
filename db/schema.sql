-- One run, and its append-only event log. The event log is what lets a page that loads mid-run
-- render identically to one that watched from the start -- and neither needs the agent process
-- that started it to still be alive.

CREATE TABLE IF NOT EXISTS run (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question      text        NOT NULL,
  status        text        NOT NULL DEFAULT 'queued',   -- queued|running|done|partial|failed|cancelled
  answer        text,
  error         text,
  attempt       int         NOT NULL DEFAULT 0,
  worker_id     text,
  heartbeat_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  finished_at   timestamptz
);

-- The claim predicate. Without this index the poll scans the table on every tick, which is
-- invisible to every latency signal and is the entire bill on a metered store.
CREATE INDEX IF NOT EXISTS run_claimable ON run (status, created_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS run_stale ON run (status, heartbeat_at) WHERE status = 'running';

CREATE TABLE IF NOT EXISTS run_event (
  run_id     uuid        NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  seq        int         NOT NULL,
  kind       text        NOT NULL,          -- step|note|error|answer
  payload    text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, seq)
);
