// The web service's own build marker, independent of the agent's. Without one, a web-only deploy
// is only observable as a deployment id in a dashboard -- and "the platform says it deployed" is a
// claim about the platform, not about which code is answering.
const WEB_MARKER = "web-exp-2";

export async function GET() {
  return Response.json({ web: WEB_MARKER });
}
