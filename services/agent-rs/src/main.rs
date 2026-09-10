//! The agent service's HTTP face. Internal on BOTH platforms -- on Vercel by having no top-level
//! rewrite of its own, on Railway by having no public domain attached. Nothing here authenticates,
//! because nothing here is reachable; a Vercel binding grants reachability and explicitly does not
//! authenticate, so if this service ever gets a public route that becomes a real hole.
//!
//! POST /runs      create a run, start it detached, return the id immediately
//! GET  /runs/:id  the run plus its events after ?after=<seq>
//! GET  /health    liveness, plus the two numbers the trial actually reads

mod agent;
mod store;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;
use store::Store;
use uuid::Uuid;

#[derive(Deserialize)]
struct CreateBody {
    question: String,
}

#[derive(Deserialize)]
struct ReadQuery {
    #[serde(default)]
    after: u32,
}

async fn create(
    State(store): State<Arc<Store>>,
    Json(body): Json<CreateBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    let question = body.question.trim().to_string();
    if question.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "question is required" })),
        );
    }

    let id = store.create(question.clone());
    // Detached: the reply is the run's ID, never its answer. A reply computed before the work it
    // describes would be a plan wearing a receipt's clothing.
    tokio::spawn(agent::run(store.clone(), id, question));

    (
        StatusCode::CREATED,
        Json(json!({ "id": id, "status": "running", "instance": store.instance })),
    )
}

async fn read(
    State(store): State<Arc<Store>>,
    Path(id): Path<Uuid>,
    Query(q): Query<ReadQuery>,
) -> (StatusCode, Json<serde_json::Value>) {
    match store.read(id, q.after) {
        Some((run, events)) => (
            StatusCode::OK,
            Json(json!({ "instance": store.instance, "run": run, "events": events })),
        ),
        // The honest answer, and the reason it is not a bare 404. With the run state in memory,
        // "no such run" has two very different causes -- this container restarted, or the poll
        // landed on a SECOND container that never saw the run -- and they need opposite work.
        // Saying so is what turns a silent architecture constraint into a visible measurement.
        None => (
            StatusCode::NOT_FOUND,
            Json(json!({
                "instance": store.instance,
                "lost": true,
                "reason": "this run is not in this container's memory: it either restarted, or \
                           your request reached a different replica. The in-memory store requires \
                           exactly one replica and does not survive a restart.",
            })),
        ),
    }
}

/// Bumped by hand to prove WHICH build is serving. A deploy is only observable if something the
/// new code produces is visible from outside it — a green checkmark says the platform finished,
/// not that the thing you changed is what answers.
const BUILD_MARKER: &str = "exp-1-server-only";

async fn health(State(store): State<Arc<Store>>) -> Json<serde_json::Value> {
    Json(json!({
        "ok": true,
        "marker": BUILD_MARKER,
        "instance": store.instance,
        "runs": store.len(),
        // The number that answers "does detached background work progress between requests on
        // this platform?" -- poll it while nothing else is happening and watch it fall to zero.
        "active": store.active(),
    }))
}

#[tokio::main]
async fn main() {
    let store = Arc::new(Store::new());
    let app = Router::new()
        .route("/runs", post(create))
        .route("/runs/{id}", get(read))
        .route("/health", get(health))
        .with_state(store.clone());

    // Every one of these platforms hands the port in on $PORT and expects a listener on it --
    // INCLUDING a Railway service with no public domain, which injects PORT=8080 and does not list
    // it among the service's variables. Believing otherwise is how this bound 8080 while `web`
    // called :3001.
    let port: u16 = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(3001);

    // Bind IPv6-first, because **Railway's private network is IPv6-only**: `agent.railway.internal`
    // resolves to an AAAA record, so a listener on 0.0.0.0 is invisible to every other service in
    // the project while looking perfectly healthy in its own logs. A dual-stack `::` socket accepts
    // IPv4-mapped connections too on Linux, so this is strictly wider -- but fall back rather than
    // assume, since a host with bindv6only set would otherwise refuse to start at all.
    let listener = match tokio::net::TcpListener::bind(("::", port)).await {
        Ok(l) => {
            println!("[agent-rs {}] listening on [::]:{port} (dual-stack)", store.instance);
            l
        }
        Err(e) => {
            println!("[agent-rs {}] [::]:{port} refused ({e}); falling back to IPv4", store.instance);
            let l = tokio::net::TcpListener::bind(("0.0.0.0", port)).await.expect("bind");
            println!("[agent-rs {}] listening on 0.0.0.0:{port} — NOT reachable over Railway's \
                      private network, which is IPv6-only", store.instance);
            l
        }
    };

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown(store))
        .await
        .expect("serve");
}

/// SIGTERM is what both platforms send before replacing a container: Vercel gives 30 seconds of
/// grace after its 5-minute scale-down, Railway on redeploy. In-flight runs die with the process
/// -- so say so in the log rather than exiting quietly, or the lost runs look like a mystery.
async fn shutdown(store: Arc<Store>) {
    let ctrl_c = tokio::signal::ctrl_c();
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("sigterm");
        tokio::select! {
            _ = ctrl_c => {},
            _ = term.recv() => {},
        }
    }
    #[cfg(not(unix))]
    let _ = ctrl_c.await;

    let active = store.active();
    println!("[agent-rs {}] shutting down, {active} run(s) in flight will be LOST", store.instance);
}
