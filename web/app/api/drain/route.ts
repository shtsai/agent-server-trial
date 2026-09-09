/**
 * VERCEL ARM ONLY. The agent container has no life of its own -- Vercel scales it down after five
 * minutes without traffic, and a poll loop is not traffic. So the heartbeat comes from outside:
 * a cron hits this route, which reaches the internal agent service over its binding.
 *
 * On Railway this route is dead code; the worker polls instead.
 */
const AGENT = () => process.env.AGENT_SERVICE_URL ?? "http://localhost:3001";

export async function GET() {
  const res = await fetch(new URL("drain", AGENT()), {
    method: "POST",
    signal: AbortSignal.timeout(300_000),
  });
  return new Response(await res.text(), { status: res.status });
}
