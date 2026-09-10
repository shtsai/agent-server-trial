# The Cloud Run arm

Cloud Run is the only platform in this trial that can be **either shape, chosen per service** — and
the point of this arm is to run both at once and feel the difference.

| Service | Billing | Scales to zero | Why |
|---|---|---|---|
| `web` | request-based (default) | ✓ | Bursty interactive traffic; pay only while serving |
| `agent-api` | request-based | ✓ | Creates runs; internal only |
| `agent-worker` | **instance-based** (`--no-cpu-throttling`) + `--min-instances=1` | ✗ | A poll loop needs CPU between requests |
| `doc` | request-based | ✓ | The polyglot arm |

## The precision this arm exists to demonstrate

**Scale-to-zero and an always-on worker are alternatives, not a combination.** `--no-cpu-throttling`
keeps CPU allocated for the instance's whole lifetime — but if the service has scaled to zero there
is no instance to allocate CPU *to*. A poll loop therefore needs **both** flags:

```bash
gcloud run deploy agent-worker \
  --source services/agent-ts \
  --no-cpu-throttling \
  --min-instances=1 --max-instances=1 \
  --no-allow-unauthenticated \
  --timeout=3600 \
  --set-env-vars=DATABASE_URL=...,ANTHROPIC_API_KEY=...,DOC_SERVICE_URL=...
```

At which point that service is not serverless and you are paying for an always-on instance — at
roughly **$47/vCPU-month** instance-based, against Railway's **$20**. Cloud Run's advantage here is
range, not price.

## The trap that cost this repo a revision

**A worker still has to listen.** Cloud Run gates a container's start on an HTTP probe against
`$PORT`. A pure poll loop with no listener never reaches "ready" and is killed as a failed
revision, with an error about the port that says nothing about the loop. `src/worker.ts` opens a
health endpoint **only when `PORT` is set**, so it stays a pure worker on Railway and becomes a
probe-satisfying service here.

## The interactive services

```bash
gcloud run deploy web --source web --allow-unauthenticated
gcloud run deploy agent-api --source services/agent-ts --no-allow-unauthenticated --timeout=3600
gcloud run deploy doc --source services/doc-py --no-allow-unauthenticated
```

`--no-allow-unauthenticated` is the internal-by-default equivalent: the service gets a URL, but only
callers with `roles/run.invoker` can use it. Unlike a Vercel binding, **the caller must send an
identity token** — Cloud Run checks it, which is one thing a Vercel binding explicitly does not do.

## What to measure

- **Cold start** on a request-based service after 15 minutes idle, against the same container on
  Vercel. This is the number the whole serverless trade turns on.
- **Whether the worker actually polls** while idle. Deploy it *without* `--no-cpu-throttling` first
  and watch it stop between requests — that failure is the lesson.
- **Cost after 7 days**, split between the request-based services and the always-on worker.
- `--timeout=3600` against Vercel's 1,800s ceiling, on a deliberately slow run.
