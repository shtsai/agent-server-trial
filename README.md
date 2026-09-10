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

## Findings so far

**Vercel runs more than one container; Railway at one replica does not.** The same 8-concurrent
`/api/health` sweep, both arms live, 2026-09-10:

| | Vercel Services | Railway (`numReplicas: 1`) |
|---|---|---|
| 20 sequential calls | 1 container | 1 container |
| **8 concurrent calls** | **split 6/2 across two** | **8/8 one container** |

A run created on one container and polled on the other answers `lost`. One browser polling
sequentially stays sticky on both platforms, which is exactly why this would have shipped unnoticed
— and why the container id is on every response. **For a no-database design, Railway's explicit
replica count is the property that makes it safe and Vercel's autoscaling is the property that
breaks it.** Neither is better; they are answers to different questions.

**What a push actually rebuilds.** Three pushes to `main`, both platforms live, measured by
deployment id per service and by a build marker each service serves about itself:

| Change | Railway `agent` | Railway `web` | Vercel |
|---|---|---|---|
| `services/agent-rs/` only | rebuilt | **skipped** | **both rebuilt** |
| `web/` only | **skipped** | rebuilt | **both rebuilt** |
| both | rebuilt | rebuilt | both rebuilt |

**Railway's `watchPatterns` work and Vercel has no equivalent by default.** A Vercel deployment is
one atomic unit, so every push rebuilds every service — including a **cold** Rust container build
(`layer store: cold (no cached images; first build or cache miss)`) triggered by editing a single
TypeScript file. Railway reused its Docker layer cache: the same Rust rebuild took **41s** there
against Vercel's **2–3 minutes** for the whole deployment, every time, regardless of what changed.

Vercel's per-service `ignoreCommand` is the intended escape hatch and is not configured here.

**The atomicity is real and worth the cost it imposes.** A probe taken mid-build on Vercel returned
the PREVIOUS build of both services — never a new frontend against an old backend. Railway makes no
such promise: `web` and `agent` deploy independently, so a push touching both has a window where one
is new and the other is not. In experiment 3 that window was **47 seconds** (agent SUCCESS at 41s,
web at 88s). That is the whole trade — Railway buys build time by giving up the guarantee.

**How you would even notice any of this:** each service serves its own marker constant
(`/api/health` → `marker`, `/api/build` → `web`). A green checkmark says the platform finished; only
something the new code produces says the change is what is answering.

**Railway's private network is IPv6-only, and that failure is silent.** `agent.railway.internal`
resolves to an AAAA record, so a server bound to `0.0.0.0` is invisible to every other service in
the project while printing "listening" and passing the platform's own deploy check. The single
symptom is `fetch failed` at the caller, one service away from the cause. Related and equally
undocumented: **Railway injects `PORT=8080` into a service with no public domain** and does not list
it among that service's variables — so the agent bound 8080 while `web` called 3001.

**The topology is declared in the repo on one platform and held account-side on the other.**
`vercel.json` declares both services, their roots and the binding between them, and Vercel reads it
**at import time**, so a reviewer can read the deployment's shape out of the repo and a PR changes
it. On Railway the same facts live in the account. Three things checked rather than assumed:

- `railway.json` — the build config this repo commits — has **no `rootDirectory`** field (verified
  against `railway.schema.json`; it carries `builder`, `dockerfilePath`, `watchPatterns`,
  `startCommand` and nothing above them).
- The **GraphQL API does**: `ServiceInstanceUpdateInput` exposes `rootDirectory`, `numReplicas`,
  `sleepApplication` and `watchPatterns` (verified by introspecting
  `backboard.railway.com/graphql/v2`). So it is scriptable — via `railway api` or the CLI — and
  "you must click it" is wrong.
- Railway is **actively shipping infrastructure-as-code** (`railway config` scaffolds
  `.railway/railway.ts`), but the published `railway@2.0.17` npm package does not export the
  `railway/iac` module that scaffold imports. So that path is not usable today and this whole
  comparison is **time-stamped, not permanent**.

The honest difference: on Vercel the service topology is a file the build reads; on Railway it is
account state you can script but the build cannot see. Both platforms punished a missing or wrong
value for the same thing with an error pointing somewhere else — Vercel with a URL parse error
naming no service, Railway with a *Node* start-command error for a *Rust* service.

**The two platforms are inverted on where configuration lives, and each is weak exactly where the
other is strong.** Vercel declares the *topology* in the repo and has **no per-service environment
variables at all** — `vercel env` is scoped to the project and to production/preview/development,
the CLI has no `service` command (zero matches in `vercel --help`), and `vercel.json`'s service
config has no `env` key (verified against `openapi.vercel.sh/vercel.json`). Railway is the mirror:
the topology is account state, but **every variable belongs to one service**.

That inversion is not trivia — it *is* why the two failures took the shape they did. A `PORT`
variable set on the Vercel project reached both services because there was nowhere else to put it;
on Railway the same variable could only ever have hit the service you set it on. Conversely
Railway's missing Root Directory could not be caught by review, because no file in the repo states
it. **Neither platform lets you review the whole deployment in one place**, they just fail on
opposite halves.

**Both failures were caused by a file in this repo inviting the mistake**, not by the platforms:
`.env.example` listed variables the platform is supposed to generate, and a root `package.json`
existed only for local convenience while being the first thing Railway's autodetect finds. Both are
gone. Prose telling you not to do something loses to a file whose shape invites it.

## Local

```bash
cp .env.example .env         # ANTHROPIC_API_KEY is the only one that matters
npm --prefix web install
make dev                     # cargo run + next dev
```

There is deliberately **no `package.json` at the repo root** — see `deploy/railway.md`.

## Deploy

`deploy/vercel.md` and `deploy/railway.md`, one page each. The Cloud Run and Azure arms were
removed along with the worker: both existed to compare *always-on poll loop* shapes, and there is no
worker any more.
