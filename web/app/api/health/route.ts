// A read-through to the agent's own health, so the container's identity and its in-flight count
// are observable from the browser. `active` is what answers "is detached work progressing between
// requests on this platform?" -- poll it with the page closed and watch it fall to zero.
const AGENT = () => process.env.AGENT_SERVICE_URL ?? "http://localhost:3001";

export async function GET() {
  try {
    const res = await fetch(`${AGENT()}/health`, { signal: AbortSignal.timeout(5_000), cache: "no-store" });
    return new Response(await res.text(), { status: res.status, headers: { "content-type": "application/json" } });
  } catch (err) {
    return Response.json({ unreachable: true, reason: String(err) }, { status: 502 });
  }
}
