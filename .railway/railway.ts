// The whole Railway project, in code. Imported from the live project with `railway config pull`
// and then extended by hand to add the `stats` service.
//
// Two things worth noticing, because they are exactly what the deprecated railway.json could NOT do:
//   * `rootDirectory` lives here, so which directory a service builds from is reviewable in a PR.
//     Getting it wrong is what made this project's first deployment fail.
//   * the dependency EDGES are `ref(...)` calls. A pasted connection string resolves to the same
//     value and records nothing: no deploy ordering, no line on the canvas. A ref is the only thing
//     that tells Railway one service depends on another.
//
// Secrets stay in the control plane. `preserve()` keeps the value that is already set without
// printing it into the repo.
import { defineRailway, github, postgres, preserve, project, ref, service, template, volume } from "railway/iac";

const REPO = "shtsai/agent-server-trial";

export default defineRailway(() => {
  const Postgres = postgres("Postgres", { region: "us-west2" });
  Postgres.networking = { privateNetworkEndpoint: "postgres" };

  const postgresVolume = volume("postgres-volume", {
    alerts: { usage: { "100": {}, "80": {}, "95": {} } },
    allowOnlineResize: true,
    region: "us-west2",
    sizeMB: 500,
  });

  // Rust. Owns the schema: `--migrate` runs between build and deploy, and a non-zero exit stops
  // the deployment with the previous version still serving.
  const agent = service("agent", {
    source: github(REPO, { checkSuites: false, rootDirectory: "services/agent-rs" }),
    build: { buildEnvironment: "V3", builder: "RAILPACK", watchPatterns: ["services/agent-rs/**"] },
    preDeploy: "agent-rs --migrate",
    replicas: { "us-west2": 1 },
    deploy: { preDeployTimeoutSeconds: 120 },
    env: {
      ANTHROPIC_API_KEY: preserve(),
      DATABASE_URL: ref(Postgres, "DATABASE_URL"),
      PORT: "3001",
      BIND_IPV4: preserve(),
    },
  });

  // TypeScript. A SECOND reader of the same database, added to test what growing this project
  // costs rather than what standing it up costs. No public domain.
  const stats = service("stats", {
    source: github(REPO, { checkSuites: false, rootDirectory: "services/stats-ts" }),
    build: { buildEnvironment: "V3", builder: "RAILPACK", watchPatterns: ["services/stats-ts/**"] },
    replicas: { "us-west2": 1 },
    env: {
      DATABASE_URL: ref(Postgres, "DATABASE_URL"),
      PORT: "3002",
    },
  });

  // Next.js. The only service with a public domain; it reaches the other two privately.
  const web = service("web", {
    source: github(REPO, { checkSuites: false, rootDirectory: "web" }),
    build: { buildEnvironment: "V3", builder: "RAILPACK", watchPatterns: ["web/**"] },
    replicas: { "us-west2": 1 },
    env: {
      AGENT_SERVICE_URL: template`http://${ref(agent, "RAILWAY_PRIVATE_DOMAIN")}:3001`,
      STATS_SERVICE_URL: template`http://${ref(stats, "RAILWAY_PRIVATE_DOMAIN")}:3002`,
    },
  });

  return project("amused-prosperity", {
    resources: [Postgres, postgresVolume, agent, stats, web],
  });
});
