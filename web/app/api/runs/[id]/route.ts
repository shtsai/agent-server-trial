// Forwards the status code UNCHANGED: a 404 here carries the reason the run is gone, and
// collapsing it into a generic error would destroy the one signal this trial is watching for.
import { agentBase, unreachable } from "@/lib/agent";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const base = agentBase();
  if ("problem" in base) return unreachable(base.problem);

  const { id } = await ctx.params;
  const after = new URL(req.url).searchParams.get("after") ?? "0";
  try {
    const res = await fetch(`${base.url}/runs/${id}?after=${after}`, {
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
    return new Response(await res.text(), {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    // The agent being unreachable is NOT the same as the run being gone, and the page has to be
    // able to tell them apart -- one is a platform failure, the other is the expected loss.
    return unreachable(err instanceof Error ? err.message : String(err));
  }
}
