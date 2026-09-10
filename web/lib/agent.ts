/**
 * Where the agent service lives, and -- when it does not -- WHY.
 *
 * The value arrives differently on every platform: Vercel generates it from the binding, Railway
 * has you set it to the private domain, and locally there is no platform at all. What they share
 * is that an EMPTY value is not the same as a MISSING one, and collapsing the two is what turned a
 * missing service into "TypeError: Failed to parse URL from /health".
 *
 * `??` was the bug. It catches null and undefined and passes "" straight through, so a binding
 * that resolved to nothing became a relative URL that fetch cannot parse -- an error about URL
 * syntax, three layers away from the fact that a service was not deployed.
 */
export type AgentBase = { url: string } | { problem: string };

export function agentBase(): AgentBase {
  const raw = process.env.AGENT_SERVICE_URL;

  // Present and empty. On Vercel this is the binding resolving to nothing, which in practice means
  // the `agent` service is not part of this deployment.
  if (raw !== undefined && raw.trim() === "") {
    return {
      problem:
        "AGENT_SERVICE_URL is set but EMPTY. On Vercel that means the binding to the `agent` " +
        "service resolved to nothing — check that `agent` actually built in this deployment. " +
        "Do not set this variable by hand; Vercel generates it.",
    };
  }

  // Absent. Fine on a laptop, never fine on a deployment -- so the answer depends on where we are.
  if (raw === undefined) {
    if (process.env.VERCEL || process.env.RAILWAY_ENVIRONMENT) {
      return {
        problem:
          "AGENT_SERVICE_URL is not set on this deployment. On Vercel the binding in vercel.json " +
          "injects it; on Railway you set it to http://agent.railway.internal:3001.",
      };
    }
    return { url: "http://localhost:3001" };
  }

  const url = raw.trim().replace(/\/+$/, "");
  // A bare host with no scheme parses as a relative URL and fails the same confusing way.
  if (!/^https?:\/\//.test(url)) {
    return { problem: `AGENT_SERVICE_URL has no http(s) scheme: ${JSON.stringify(raw)}` };
  }
  return { url };
}

/** One shape for "the agent is not reachable", so the page can tell it from "the run is gone". */
export function unreachable(reason: string) {
  return Response.json({ unreachable: true, reason }, { status: 502 });
}
