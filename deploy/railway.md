# The Railway arm

Three services in **one project and one environment** — private networking (`*.railway.internal`)
only works within that boundary, and does not reach Vercel or another Railway project.

| Service | Root | Dockerfile | Public domain | Start |
|---|---|---|---|---|
| `web` | repo root | `web/Dockerfile` (or Nixpacks/Next preset) | **yes** | `next start` |
| `agent-worker` | repo root | `services/agent-ts/Dockerfile` | **no** | `npm run worker` |
| `doc` | `services/doc-py/` | `services/doc-py/Dockerfile` | **no** | uvicorn |

`agent-worker` gets **no public domain**: no ingress, nothing to authenticate, nothing to attack.
That is the arm's whole security claim, and it is also why **app sleeping cannot be used on it** —
sleeping wakes on an inbound request, and a worker has none.

## Settings that matter

- **Watch paths** so a `web/`-only change does not rebuild the worker:
  `services/agent-ts/**` for `agent-worker`, `services/doc-py/**` for `doc`, `web/**` for `web`.
- **Build context is the repo root** for `agent-worker` (npm workspaces), so set the root directory
  to `/` and point at the Dockerfile path. `doc` is self-contained and can use its own root.
- **Deploy ordering comes from reference variables.** Give `web` a
  `DOC_HEALTH=${{doc.RAILWAY_PRIVATE_DOMAIN}}`-style reference if you want to *observe* the
  ordering behaviour — a service that references another waits for it in a batch deploy.
- **Env**: `DATABASE_URL` (same Neon database as the Vercel arm), `ANTHROPIC_API_KEY`,
  `DOC_SERVICE_URL=http://doc.railway.internal:8000`, and on `web`,
  `AGENT_SERVICE_URL` — but note the Railway arm has no agent HTTP service by default. Either run a
  second `agent-api` service from the same image with `npm start`, or point `web` at it. **Deciding
  this is part of the experiment**: the Vercel arm forces one shape, Railway allows two.

> Railway config-as-code (`railway.json` per service) is deliberately NOT committed here — the
> schema was not verified when this was written, and a wrong committed config is worse than none.
> Configure in the dashboard first, then export it if it proves worth pinning.

## Cost expectation

A ~250 MB idle Node worker is about **$2.50/month** ($10/GB-RAM-month, metered per second); idle CPU
rounds to zero. Hobby is $5/month including $5 of usage, so the whole arm should sit inside it.
