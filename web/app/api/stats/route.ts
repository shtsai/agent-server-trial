// Proxies the internal stats service, the same way /api/health proxies the agent. The address is
// injected by the platform; on Railway it is declared in .railway/railway.ts as a reference, so
// the edge between these two services is visible in the repo rather than only in the dashboard.
const STATS = () => process.env.STATS_SERVICE_URL?.trim();

export async function GET() {
  const base = STATS();
  if (!base) {
    return Response.json(
      { unreachable: true, reason: "STATS_SERVICE_URL is not set — the stats service is a Railway-only arm" },
      { status: 501 },
    );
  }
  try {
    const res = await fetch(`${base}/stats`, { signal: AbortSignal.timeout(10_000), cache: "no-store" });
    return new Response(await res.text(), { status: res.status, headers: { "content-type": "application/json" } });
  } catch (err) {
    return Response.json({ unreachable: true, reason: String(err) }, { status: 502 });
  }
}
