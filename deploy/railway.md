# The Railway arm

Two services in **one project and one environment** — private networking (`*.railway.internal`) is
scoped to exactly that boundary and does not reach Vercel or another Railway project.

| Service | Root directory | Public domain | Start |
|---|---|---|---|
| `web` | `web/` | **yes** | `next start` (Nixpacks/Next preset) |
| `agent` | `services/agent-rs/` | **no** | the `Dockerfile` |

Both roots are **self-contained**, which is a deliberate change: the previous TypeScript service
needed npm workspaces and therefore a repo-root build context, so it carried two Dockerfiles. A
Cargo project needs nothing above its own directory, so one Dockerfile serves every platform.

## Setup, in order

1. New project → deploy from the GitHub repo. Add **two services** from the same repo.
2. `agent`: root directory `services/agent-rs`, builder **Dockerfile**. **Attach no public domain.**
3. `web`: root directory `web`. Attach a public domain.
4. **Watch paths**, so a `web/`-only change does not rebuild Rust: `services/agent-rs/**` on
   `agent`, `web/**` on `web`.
5. Env:
   - `agent` → `ANTHROPIC_API_KEY`
   - `web` → `AGENT_SERVICE_URL=http://agent.railway.internal:3001`
     (Railway does not inject this; unlike Vercel, you set it — and a reference variable
     `${{agent.RAILWAY_PRIVATE_DOMAIN}}` is the way to make `web` wait for `agent` in a batch deploy,
     which is the ordering behaviour worth observing.)
6. **Replicas: 1, and leave it there.** With run state in memory, a second replica means a poll can
   land on a container that never saw the run. The page banners it and `/api/health` shows the
   instance changing, but the fix is one replica, not better polling.

## App sleeping

`agent` has no public domain, so it has no inbound traffic of its own — but **it does receive
traffic**: every poll from `web` arrives over the private network. That is the difference from the
old worker arm, where sleeping was unusable because a poll loop generates no ingress. Whether
Railway's sleep counts private-network traffic as a wake signal is **worth measuring** and is not
documented clearly.

## Cost expectation

A Rust binary idles at roughly 10–20 MB RSS against the old Node worker's ~250 MB. At $10/GB-RAM-month
metered per second, that is cents rather than $2.50 — the always-on cost of this arm is now
essentially the `web` service. Hobby ($5/month, $5 usage included) should cover the whole thing.

## Verify

```bash
curl https://<railway-domain>/api/health   # proxied through web to the internal agent
```

Same three signals as the Vercel arm: `unreachable` means private networking is not wired,
`lost` means the container restarted, and a changing `instance` means more than one replica.
