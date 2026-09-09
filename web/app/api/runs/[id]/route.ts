const AGENT = () => process.env.AGENT_SERVICE_URL ?? "http://localhost:3001";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const after = new URL(req.url).searchParams.get("after") ?? "0";
  const res = await fetch(`${AGENT()}/runs/${id}?after=${after}`, { signal: AbortSignal.timeout(10_000) });
  return new Response(await res.text(), { status: res.status, headers: { "content-type": "application/json" } });
}
