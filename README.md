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

## The two deployments

| | Vercel Services | Railway |
|---|---|---|
| Frontend | `web` service | `web` service |
| Agent | `agent` service, **no public rewrite** (internal) | `agent` service, no public domain |
| Python | `doc` service, internal, reached via **binding** | `doc` service, via `*.railway.internal` |
| Work is driven by | `POST /drain` from Vercel Cron | an always-on poll loop |
| Deploys | one atomic deployment | ordered by reference variables |

The asymmetry in that "driven by" row is the whole experiment: a Vercel container scales down after
**5 minutes without traffic**, so a poll loop cannot exist there. Railway's can.

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
