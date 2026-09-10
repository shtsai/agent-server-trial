# The Azure Container Apps arm

Included because **Azure is already a subprocessor** for the parent project (Document Intelligence),
and a provider you already have a DPA with is materially cheaper than one you do not — see
`docs/platform/server.md` § "The axis nobody prices" in `legal_demo`.

Technically it sits close to Cloud Run: Consumption plan scales to zero, KEDA-based scaling, native
jobs. Its reported weakness is cold-start and autoscaling responsiveness, which matters much less
for batch and queue work than for interactive traffic.

```bash
# Internal-only agent service — reachable from other apps in the same environment, not the internet
az containerapp create --name agent-api --resource-group rg-trial --environment trial-env \
  --image <registry>/agent-ts:latest --target-port 3001 --ingress internal \
  --min-replicas 0 --max-replicas 3

# The always-on worker
az containerapp create --name agent-worker --resource-group rg-trial --environment trial-env \
  --image <registry>/agent-ts:latest --min-replicas 1 --max-replicas 1
```

## The same trap, a third time

Azure documents it explicitly: **if ingress is disabled and you define neither `minReplicas` nor a
custom scale rule, the app scales to zero and has no way of starting back up.** That is the identical
failure as Railway's app sleeping (wakes only on inbound traffic) and Cloud Run's `--min-instances=0`
with `--no-cpu-throttling` (nothing to allocate CPU to).

**The general rule, worth more than any of the three:** on every platform, "always-on" and "scales to
zero" are the same dial, and a background worker with no inbound traffic sits at the end of it where
nothing can restart it. A worker is not a server, and every serverless container platform is built
for servers.

KEDA is Azure's way out that the others lack: an **external** scale trigger — a queue with messages
in it — can wake an app from zero, because the signal lives outside the app. That is the one design
that genuinely gets both properties, and it is why "use a real queue" and "scale to zero" are the
same decision.

## What to measure

- Cold start against Cloud Run's, on the same image.
- Whether a KEDA queue trigger actually wakes the worker from zero — the one capability neither
  Vercel nor Railway offers.
- Cost after 7 days, and how much of it is the always-on replica.
