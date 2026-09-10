# agent-server-trial

One toy agent app, deployed **twice** — to Vercel Services and to Railway — so the comparison is
controlled rather than two impressions. Throwaway by design: the output is a decision, not a system.

Full context and the questions this exists to answer live in `legal_demo`'s
`docs/platform/server.md`.

## What it is

A minimal agentic backend: submit a question, a 3-step loop calls Claude, progress is persisted and
streamed, and a run survives a browser refresh and a worker restart.

```
web/                 Next.js frontend — submit a run, subscribe to its events
services/agent-ts/   TypeScript agent service (the thing under test)
services/doc-py/     Python FastAPI service — exists only to exercise polyglot + bindings
db/schema.sql        Postgres: run + run_event
```

**One Neon Postgres database serves both deployments**, so the only variable is the platform.

## The four deployments

Same code, one Neon Postgres, four platforms. `deploy/` has a page each.

| | Vercel Services | Railway | Cloud Run | Azure Container Apps |
|---|---|---|---|---|
| Agent reachable publicly? | no rewrite | no domain | `--no-allow-unauthenticated` | `--ingress internal` |
| Work driven by | `POST /drain` from Cron | always-on poll loop | poll loop, `--no-cpu-throttling` + `--min-instances=1` | always-on replica, or a KEDA queue trigger |
| Scales to zero | ✓ | ✗ if no ingress | ✓ per service, not the worker | ✓, and KEDA can wake it |
| Long jobs | 30 min | unbounded | 60 min + Jobs | jobs |
| Deploys | one atomic deployment | ordered by reference variables | per service | per app |

**The "driven by" row is the whole experiment.** A Vercel container scales down after 5 minutes
without traffic, so a poll loop cannot exist there at all. The others can run one — but on every
single one of them, doing so means giving up scale-to-zero for that service. Azure's KEDA queue
trigger is the only escape on the list, because the wake signal lives *outside* the app.

**And a worker still has to listen.** Cloud Run and Azure both gate container start on an HTTP probe
against `$PORT`; a pure poll loop with no listener is killed as a failed revision, with an error
about the port. `src/worker.ts` opens a health endpoint only when `PORT` is set.

## What to measure (not read)

1. Deploy wall time, and what happens when one service is deliberately slow to build.
2. Cold start on the first request after idle.
3. Real cost after seven days.
4. **`kill -9` the worker mid-run.** Does exactly one answer come out? This is the ballgame.

## Setup

```bash
cp .env.example .env          # fill in DATABASE_URL + ANTHROPIC_API_KEY
npm install
psql "$DATABASE_URL" -f db/schema.sql
npm run dev
```
