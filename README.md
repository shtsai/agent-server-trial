# agent-server-trial

One toy agent app, deployed **twice** — to Vercel Services and to Railway — so the comparison is
controlled rather than two impressions. Throwaway by design: the output is a decision, not a system.

Full context and the questions this exists to answer live in `legal_demo`'s
`docs/platform/server.md`.

## What it is

```
web/                 Next.js frontend — submit a run, poll it, render what happened
services/agent-rs/   Rust (axum + tokio) agent service — the thing under test
```

Submit a question; a 3-step loop calls Claude; each step is appended to the run and rendered as it
lands. **There is no database.** The frontend and the agent talk directly over the platform's own
internal networking — a Vercel binding, or Railway private networking — and the run lives in the
agent process's memory.

## What that trade actually costs

The database was doing two jobs, and only one of them is replaced.

| | With Postgres | Now |
|---|---|---|
| Queue between frontend and worker | the `run` table | **gone** — the frontend calls the agent directly |
| Browser refresh mid-run | survives | **survives** (state is server-side, keyed by id) |
| Container restart mid-run | survives, requeued | **run is lost** |
| More than one replica | fine | **broken** — a poll can hit a container that never saw the run |

Those last two are the price, and they are paid deliberately: this trial is measuring **platform
plumbing**, not durability, and a queue that exists only to be a queue is exactly what the direct
path removes.

**The replica hazard is the dangerous one**, because it works perfectly at one replica and fails
intermittently at two — which reads as a flaky product rather than an architecture constraint. So it
is made *visible* rather than documented: every response carries the container's `instance` id, the
page compares the container that created a run against the one answering each poll and banners any
difference, and a poll that finds no run returns an explicit `lost` with the reason rather than a
bare 404.

## What to measure (not read)

1. **Does detached background work progress between requests?** Submit a run, close the tab, wait
   20s, read `active` from `/api/health`. On Vercel this is an inference from the 5-minute
   scale-down, not a guarantee — and if it is wrong, this whole shape is wrong there.
2. **Does the platform keep you on one container?** Poll `/api/health` under concurrent load and
   watch `instance`. This is the ballgame now.
3. Deploy wall time, and what a slow-building service does to the other one.
4. Cold start on the first request after idle.
5. Real cost after seven days.
6. `kill -9` the agent mid-run. The run *should* be lost — the measurement is whether the frontend
   says so honestly and promptly, or hangs.

## Endpoints

| | |
|---|---|
| `POST /api/runs` `{question}` | → `{id, status, instance}`, work starts detached |
| `GET /api/runs/:id?after=<seq>` | → `{run, events, instance}`, or 404 `{lost, reason}` |
| `GET /api/health` | → `{ok, instance, runs, active}` |

All three proxy through `web`; the agent is internal on both platforms and is never called from the
browser.

## Local

```bash
cp .env.example .env         # ANTHROPIC_API_KEY is the only one that matters
npm --prefix web install
npm run dev                  # cargo run + next dev
```

## Deploy

`deploy/vercel.md` and `deploy/railway.md`, one page each. The Cloud Run and Azure arms were
removed along with the worker: both existed to compare *always-on poll loop* shapes, and there is no
worker any more.
