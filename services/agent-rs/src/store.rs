//! The run store. It is a `HashMap` behind a lock, and that is the whole design decision this
//! trial turns on: with no database, a run exists only in the memory of the container that
//! started it.
//!
//! Two properties follow, and both are load-bearing:
//!
//! 1. **A refresh loses nothing.** State is server-side and keyed by id, so a page that reloads
//!    mid-run re-attaches to the same run. That is the property the database was carrying, and
//!    it survives without one.
//! 2. **Exactly one replica.** A second container has never heard of the first one's runs. That
//!    fails only under concurrency, so it would read as an intermittent product bug rather than
//!    as an architecture constraint -- which is why every response carries `instance`, and why a
//!    poll that lands on the wrong container answers `lost` with a reason rather than a bare 404.
//!
//! What is deliberately NOT here: a claim predicate, an attempt counter, a stale-run requeue. All
//! three exist to survive a worker dying, and nothing in memory survives that. Pretending
//! otherwise with a retry counter would be the system lying about a guarantee it does not have.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::RwLock;
use std::time::{Duration, Instant};
use uuid::Uuid;

/// Terminal states stay DISTINCT. Collapsing `partial` into `done` makes the system lie about
/// whether the answer it is showing is the whole answer.
#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Running,
    Done,
    Partial,
    Failed,
}

impl Status {
    fn is_terminal(self) -> bool {
        !matches!(self, Status::Running)
    }
}

#[derive(Clone, Serialize)]
pub struct Event {
    pub seq: u32,
    pub kind: &'static str, // step | note | error | answer
    pub payload: String,
}

pub struct Run {
    pub question: String,
    pub status: Status,
    pub answer: Option<String>,
    pub error: Option<String>,
    pub events: Vec<Event>,
    finished_at: Option<Instant>,
}

/// What a caller sees. Separate from `Run` so the internals (timers, the event vec) cannot leak
/// into the wire shape by accident.
#[derive(Serialize)]
pub struct RunView {
    pub id: Uuid,
    pub question: String,
    pub status: Status,
    pub answer: Option<String>,
    pub error: Option<String>,
}

/// How long a finished run stays readable. Without this the map is a leak with a nice name: a
/// long-lived Railway container would accumulate every run it ever served.
const RETAIN: Duration = Duration::from_secs(30 * 60);

pub struct Store {
    runs: RwLock<HashMap<Uuid, Run>>,
    /// Identifies this PROCESS, and it must not identify anything coarser. The point of it is to
    /// catch a poll answered by a container that never saw the run, so anything shared between
    /// replicas silently disables the detector -- and a detector that never fires is
    /// indistinguishable from one that found nothing.
    ///
    /// `VERCEL_DEPLOYMENT_ID` was exactly that mistake: every replica of one deployment reports
    /// the same value, which is the case being looked for. A random id per process is the only
    /// thing that is right on every platform, so nothing is read from the environment.
    pub instance: String,
}

impl Store {
    pub fn new() -> Self {
        Self {
            runs: RwLock::new(HashMap::new()),
            instance: Uuid::new_v4().to_string()[..8].to_string(),
        }
    }

    pub fn create(&self, question: String) -> Uuid {
        let id = Uuid::new_v4();
        let mut runs = self.runs.write().unwrap();
        runs.insert(
            id,
            Run {
                question,
                status: Status::Running,
                answer: None,
                error: None,
                events: Vec::new(),
                finished_at: None,
            },
        );
        Self::sweep(&mut runs);
        id
    }

    pub fn append(&self, id: Uuid, kind: &'static str, payload: String) {
        if let Some(run) = self.runs.write().unwrap().get_mut(&id) {
            let seq = run.events.len() as u32 + 1;
            run.events.push(Event { seq, kind, payload });
        }
    }

    pub fn finish(&self, id: Uuid, status: Status, answer: Option<String>, error: Option<String>) {
        if let Some(run) = self.runs.write().unwrap().get_mut(&id) {
            run.status = status;
            if answer.is_some() {
                run.answer = answer;
            }
            run.error = error;
            run.finished_at = Some(Instant::now());
        }
    }

    /// Events strictly after `after_seq`, so a poller never re-renders what it already has and a
    /// page that arrives mid-run gets the whole log by asking from 0.
    pub fn read(&self, id: Uuid, after_seq: u32) -> Option<(RunView, Vec<Event>)> {
        let runs = self.runs.read().unwrap();
        let run = runs.get(&id)?;
        Some((
            RunView {
                id,
                question: run.question.clone(),
                status: run.status,
                answer: run.answer.clone(),
                error: run.error.clone(),
            },
            run.events.iter().filter(|e| e.seq > after_seq).cloned().collect(),
        ))
    }

    pub fn len(&self) -> usize {
        self.runs.read().unwrap().len()
    }

    fn sweep(runs: &mut HashMap<Uuid, Run>) {
        let now = Instant::now();
        runs.retain(|_, r| match r.finished_at {
            Some(t) => now.duration_since(t) < RETAIN,
            None => true,
        });
    }
}

impl Store {
    /// Runs still working. This is what a `kill -9` destroys, and the only honest way to see
    /// whether a platform is letting detached work run between requests.
    pub fn active(&self) -> usize {
        self.runs.read().unwrap().values().filter(|r| !r.status.is_terminal()).count()
    }
}
