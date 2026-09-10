# The Vercel arm

One project, **two services, one atomic deployment**. Both build in parallel and nothing goes live
until both are ready — so there is no window in which a new frontend talks to an old backend.

`vercel.json` at the repo root declares all of it:

| Service | Root | Runtime | Public |
|---|---|---|---|
| `web` | `web/` | Next.js | **yes** — the single top-level rewrite |
| `agent` | `services/agent-rs/` | container (`Dockerfile`) | **no rewrite of its own, so unreachable from the internet** |

`web` reaches `agent` over a **binding**, which injects `AGENT_SERVICE_URL` at runtime. Vercel
generates that value — never set it yourself.

## Setup, in order

1. **Import the repo** at vercel.com. **Root Directory must stay the repo root (`./`)**, not `web/`.
   The `services` block is only read from the root; pointing at `web/` silently produces a
   single-service project with no agent and no obvious error.
2. **Set `ANTHROPIC_API_KEY`** (Production + Preview) *before* the first deploy. **It is the only
   variable you set, and this is the step that actually goes wrong.**

   Do **not** add `AGENT_SERVICE_URL`, and do **not** add `PORT`. A project environment variable
   *shadows* the value Vercel generates for a binding, so an `AGENT_SERVICE_URL` you set by hand
   wins over the real one — and if it is empty, `web` reads `""` and every call to the agent dies
   as a URL parse error naming no service at all. `PORT` is worse in kind: it applies to every
   service in the project, including containers the platform assigns a port to.

   This happened on the first deployment of this repo. Both services had built correctly; the
   config was right; the cause was three variables pasted out of `.env.example` into the
   dashboard. Two of the three belong to the platform.
3. **Deploy by pushing to `main`.** Never `vercel --prod` from a checkout — it deploys the tree you
   are standing in, which is how a stale commit reaches production while reporting success.

## Verify — the checks are ordered so each failure is distinguishable

```bash
curl https://<url>/api/health     # {"ok":true,"instance":"…","runs":0,"active":0}
```

- `{"unreachable":true}` → the **binding did not resolve**. Check that the `agent` service actually
  built; a single-service project fails exactly this way.
- A 404 on a run → the run is **lost**, and the JSON says which of the two causes it was.
- **Call `/api/health` twice and compare `instance`.** If it changes while you are using the site,
  Vercel is running more than one replica — and with run state in memory, that is the failure this
  whole shape has. The page banners it too.

## What removing the database changed here

The old arm needed a cron on `/api/drain`, because a container scales down after **5 minutes**
without traffic and a poll loop is not traffic. **With the frontend talking to the agent directly,
none of that exists.** The browser's own 1s poll is inbound traffic, so the container stays warm for
exactly as long as a run is being watched, and scale-down happens when nobody is looking — which is
the correct behaviour rather than a workaround.

## The open question this arm is here to answer

`POST /runs` returns immediately and the work continues in a detached `tokio::spawn`. A Vercel
Service container keeps running between requests until it scales down, so this *should* progress —
but that is an inference, not a documented guarantee. **Measure it:** submit a run, close the tab,
wait 20s, then hit `/api/health` and read `active`. If it is still 1 and the run never completes,
detached work is being suspended between requests and the whole no-database shape is wrong here.

## Things to watch

- Bindings resolve **at runtime only** — not during a build, and not in middleware.
- A binding **grants reachability and does not authenticate**. `agent` has no auth because it has
  no public route; the day it gets one, that is a real hole.
- Billing: no per-service base fee. Each is billed like a function — Active CPU, provisioned memory,
  invocations — and **Active CPU excludes I/O wait inside a request**, which matters here because
  the agent spends nearly all of its time blocked on Anthropic.
