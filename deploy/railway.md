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
2. **`agent`: set Root Directory to `services/agent-rs` BEFORE the first build.** This is the step
   that fails, and it fails confusingly — see below. Builder is **Dockerfile**, picked up from the
   committed `services/agent-rs/railway.json`. **Attach no public domain.**
3. **`web`: set Root Directory to `web`.** Attach a public domain.

### The failure this arm hits first

A service whose Root Directory is unset builds from the **repo root**, and Railway's builder
autodetects a language there. The error it produces has nothing to do with the real problem:

```
⚠ No node package manager detected, using npm
↳ Detected Node
✖ No start command detected. Specify a start command
```

That is a **Node** error for a **Rust** service. The repo root now contains no `package.json` and
no manifest of any kind (a `Makefile` drives local dev instead) precisely so this cannot happen
again — but the underlying constraint is permanent, and it is a real difference between the two
platforms in this trial:

> **Railway's `railway.json` has no `rootDirectory` field** — verified against
> `railway.schema.json`, which exposes `builder`, `dockerfilePath`, `watchPatterns` and
> `startCommand` and nothing above them. **The build config the repo commits cannot say which
> directory the service builds from.**
>
> It is *not* dashboard-only, though: the GraphQL API's `ServiceInstanceUpdateInput` exposes
> `rootDirectory` (and `numReplicas`, `sleepApplication`, `watchPatterns`) — verified by
> introspecting `backboard.railway.com/graphql/v2` — so it is scriptable through `railway api`.
> Railway is also shipping IaC (`railway config` → `.railway/railway.ts`), but the published
> `railway@2.0.17` package does not export the `railway/iac` module that file imports, so that
> path does not work yet. **Treat this paragraph as dated.**
>
> The difference from Vercel that survives all of that: `vercel.json` is read **at import time**,
> so the topology is a reviewable file the build itself consumes. Railway's equivalent is account
> state — scriptable, but invisible to the repo, so a cloned environment reproduces it only if
> someone re-runs the script.

`railway.json` is committed per service for everything it *can* carry (builder, Dockerfile path,
watch patterns). Root Directory is the one thing it cannot, so it stays step 2.
4. **Watch paths** are committed in each `railway.json`, so a `web/`-only change does not rebuild
   Rust. Confirm they took effect rather than assuming.
5. Env:
   - `agent` → `ANTHROPIC_API_KEY`
   - `agent` → also `PORT=3001`. **Railway injects `PORT=8080` into a service even when it has no
     public domain**, and does not list it among the service's variables — so without this pin the
     agent binds 8080 while `web` calls 3001, and the only symptom is `fetch failed`. Setting it
     per-service is safe here in a way it is not on Vercel, which has no per-service env at all.
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

### Railway's private network is IPv6-only

`agent.railway.internal` resolves to an **AAAA** record. A server bound to `0.0.0.0` is IPv4-only,
so it is invisible to every other service in the project **while looking perfectly healthy in its
own logs** — it prints "listening", the platform reports the deploy SUCCESS, and the only evidence
is `fetch failed` at the caller. `src/main.rs` binds `::` (dual-stack, which accepts IPv4-mapped
connections too) and falls back to `0.0.0.0` with a log line saying it will not be reachable.

This has no analogue on the Vercel arm, where a binding is resolved for you.

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
