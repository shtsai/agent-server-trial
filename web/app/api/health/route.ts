// A read-through to the agent's own health, and the first thing to call when something is wrong:
// it distinguishes "the address is not configured" from "the agent is not answering" from "the
// agent is fine", which are three different repairs.
import { agentBase, unreachable } from "@/lib/agent";

export async function GET() {
  const base = agentBase();
  if ("problem" in base) return unreachable(base.problem);

  try {
    const res = await fetch(`${base.url}/health`, { signal: AbortSignal.timeout(5_000), cache: "no-store" });
    return new Response(await res.text(), { status: res.status, headers: { "content-type": "application/json" } });
  } catch (err) {
    return unreachable(
      `reached for ${base.url}/health and got: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
