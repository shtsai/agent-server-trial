# The Vercel arm

One project, three services, **one atomic deployment** — all services build separately and in
parallel, and nothing goes live until every one of them is ready. A slow-building service delays the
deploy; it does not create a window where a new frontend talks to an old backend.

`vercel.json` at the repo root declares all of it. The single top-level rewrite sends public traffic
to `web`; `agent` and `doc` have **no rewrite of their own, so they are unreachable from the
internet**. They are reached only over bindings, which inject `AGENT_SERVICE_URL` and
`DOC_SERVICE_URL` at runtime. Vercel generates those values — never set them yourself.

## The constraint this arm is here to demonstrate

A container scales down after **5 minutes without traffic** in production (30 seconds in preview),
with `SIGTERM` and a 30-second grace period. **A polling worker therefore cannot exist here.** The
cron on `/api/drain` is the substitute: something outside the container has to provide the heartbeat.

## Env vars to set in the project

`DATABASE_URL`, `ANTHROPIC_API_KEY`. Everything else is injected.

## Things to watch

- Bindings resolve **at runtime only** — not during a build, and not in middleware.
- An internal call skips the firewall, Deployment Protection, middleware and CDN accounting, and a
  binding **grants reachability but does not authenticate**. Application-level authorization between
  services is your job.
- Billing: services carry no per-service base fee; each is billed like a function (Active CPU +
  provisioned memory + invocations). A binding call is one service request with no separate Edge
  Request or Fast Data Transfer charge.
