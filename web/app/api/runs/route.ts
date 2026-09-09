// The frontend never calls the agent service from the browser -- the agent is internal on both
// platforms. This route is the only thing that knows its address.
const AGENT = () => process.env.AGENT_SERVICE_URL ?? "http://localhost:3001";

export async function POST(req: Request) {
  const body = await req.text();
  const res = await fetch(`${AGENT()}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  return new Response(await res.text(), { status: res.status, headers: { "content-type": "application/json" } });
}
