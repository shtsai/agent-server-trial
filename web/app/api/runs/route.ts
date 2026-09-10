// The browser never calls the agent service directly -- it is internal on both platforms, and a
// Vercel binding is resolvable only at runtime, inside a server process.
import { agentBase, unreachable } from "@/lib/agent";

export async function POST(req: Request) {
  const base = agentBase();
  if ("problem" in base) return unreachable(base.problem);

  const body = await req.text();
  try {
    const res = await fetch(`${base.url}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
    return new Response(await res.text(), {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    return unreachable(err instanceof Error ? err.message : String(err));
  }
}
