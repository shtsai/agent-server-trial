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
   - `web` → `AGENT_SERVICE_URL=http://${{agent.RAILWAY_PRIVATE_DOMAIN}}:3001`

     **Use the reference form, not the literal `agent.railway.internal`.** They resolve to the same
     string, but a reference is the ONLY way Railway learns that `web` depends on `agent`: it is
     what draws the connection between the two boxes in the project canvas, and what makes `web`
     wait for `agent` in a batch deploy. With a literal, the two services are independent boxes and
     nothing anywhere records that one calls the other — the dependency exists only in a running
     process. This is Railway's answer to a Vercel `binding`, and unlike a binding you have to opt
     into it.

     Read it back with `railway api 'query…variables(…, unrendered: true)'`; the CLI's
     `railway variables --kv` shows the RESOLVED value, so a literal and a reference look identical
     there.
6. **Replicas: 1, and leave it there.** With run state in memory, a second replica means a poll can
   land on a container that never saw the run. The page banners it and `/api/health` shows the
   instance changing, but the fix is one replica, not better polling.

## Deployment ordering — it exists, and it does not fire on a git push

Railway **does** order deploys by dependency, and the dependency is the reference variable:

> "A service that references another service waits for that service to finish deploying before it
> starts, so it never boots with a stale or missing value from a dependency."

Ordering follows the whole chain (A→B→C means A waits for both), and a circular reference deploys
the conflicting services in parallel rather than deadlocking.

**But it applies only to BATCH deploys** — template deploys, applying staged changes, duplicating an
environment, and PR environments. Railway's docs are explicit about the exclusion:

> "GitHub push deploys — even in a monorepo where one push triggers multiple services, each service
> deploys independently."

That is exactly this project's path, and it matches what was measured here: in the both-services
experiment, `agent` and `web` were **both `BUILDING` at the same 25-second poll**, and `agent`
finished 47 seconds before `web`. No ordering occurred, and none was supposed to.

**Measured, and it works — the gate is on DEPLOY, not on BUILD.** Duplicating the environment with
`agent` deliberately slowed (`--service-config agent deploy.preDeployCommand "sleep 150"`) so the
constraint had to bind:

```
  0-80s   agent=BUILDING   web=BUILDING     builds run in PARALLEL
 90-200s  agent=BUILDING   web=QUEUED       web finished building, then WAITED 130s
   210s   agent=DEPLOYING  web=QUEUED
   220s   agent=SUCCESS    web=DEPLOYING    released the instant agent succeeded
   230s   agent=SUCCESS    web=SUCCESS
```

Three things this settles, each of which an earlier run here got wrong:

- **Ordering is real on a batch path**, and `RAILWAY_PRIVATE_DOMAIN` — a *platform-provided*
  variable — counts as a dependency reference. It does not have to be one you defined.
- **Only the deploy step is ordered.** Both services build concurrently; the dependent one parks in
  `QUEUED` between its build finishing and its container starting. So the wall-clock cost of
  ordering is bounded by the *dependency's* deploy time, not by serialising two builds.
- **A test where the constraint never binds proves nothing.** The first attempt here duplicated the
  environment unmodified: `agent` finished in 21s while `web` was still 88s into its own build, so
  `web` never had to wait and the run looked identical to no ordering at all. It was recorded as
  "PARALLEL — ordering did not happen". Making the dependency SLOWER than the dependent is what
  turned an unfalsifiable observation into a measurement.

**So the reference variable is still worth having** — it records the edge, draws the canvas
connection, and *does* order a batch deploy — but on the push path it buys ordering you will not
get. If you need the ordering, the deploy has to *be* a batch, and reaching one deliberately is
harder than it looks:

- `environmentTriggersDeploy` reads like the answer ("Deploys all connected triggers for an
  environment") but its input requires a `serviceId`, so it is per-service, not a batch.
- `railway variable set --skip-deploys` **applies** the change without deploying rather than
  staging it, so `environmentPatchCommitStaged` then answers `"No patch to apply"`. Staged changes
  appear to be dashboard-only.
- The batch paths that definitely work are the documented four: template deploys, applying staged
  changes **from the dashboard**, duplicating an environment, and PR environments.

**And ordering is not compatibility.** It solves the ADDITIVE direction — `web` starts calling a new
endpoint, so `agent` must be live first. It does nothing for a removal or a rename, because the
window then contains a NEW `agent` and an OLD `web`, which is the same breakage from the other side.
For those, expand/contract is the only answer on any platform: teach `agent` both shapes, ship
`web`, then drop the old shape. Note also that neither platform protects the browser→`web` hop: a
reader with the page already open is running old JavaScript against whatever the backend now is.

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
