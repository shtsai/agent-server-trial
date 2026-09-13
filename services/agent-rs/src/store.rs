//! The run store, in two backends chosen at boot by whether `DATABASE_URL` is set.
//!
//! **The point of keeping both is that the difference is the experiment.** In memory, a run exists
//! only inside the container that started it: a refresh re-attaches, a restart destroys it, and a
//! second replica cannot see it — so the design needs exactly one replica and tolerates losing work.
//! In Postgres none of those hold, and the cost is a network hop and a thing to operate.
//!
//! Both are real. Neither is a stub, because a stubbed backend would make every comparison between
//! them a comparison of the stub.

use serde::Serialize;
use sqlx::{postgres::PgPoolOptions, PgPool, Row};
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
    fn as_str(self) -> &'static str {
        match self {
            Status::Running => "running",
            Status::Done => "done",
            Status::Partial => "partial",
            Status::Failed => "failed",
        }
    }
    fn from_str(s: &str) -> Status {
        match s {
            "done" => Status::Done,
            "partial" => Status::Partial,
            "failed" => Status::Failed,
            _ => Status::Running,
        }
    }
    fn is_terminal(self) -> bool {
        !matches!(self, Status::Running)
    }
}

#[derive(Clone, Serialize)]
pub struct Event {
    pub seq: i32,
    pub kind: String, // step | note | error | answer
    pub payload: String,
}

#[derive(Serialize)]
pub struct RunView {
    pub id: Uuid,
    pub question: String,
    pub status: Status,
    pub answer: Option<String>,
    pub error: Option<String>,
}

/// The schema. Applied by `agent-rs --migrate`, which the platform runs BEFORE the new version
/// starts serving — so a failed migration blocks the deploy instead of shipping code against a
/// database that cannot hold it.
pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS run (
  id          uuid PRIMARY KEY,
  question    text        NOT NULL,
  status      text        NOT NULL,
  answer      text,
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE TABLE IF NOT EXISTS run_event (
  run_id  uuid NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  seq     int  NOT NULL,
  kind    text NOT NULL,
  payload text NOT NULL,
  PRIMARY KEY (run_id, seq)
);
CREATE INDEX IF NOT EXISTS run_active ON run (status) WHERE status = 'running';
"#;

struct MemRun {
    question: String,
    status: Status,
    answer: Option<String>,
    error: Option<String>,
    events: Vec<Event>,
    finished_at: Option<Instant>,
}

const RETAIN: Duration = Duration::from_secs(30 * 60);

enum Backend {
    Memory(RwLock<HashMap<Uuid, MemRun>>),
    Pg(PgPool),
}

pub struct Store {
    backend: Backend,
    /// Identifies this PROCESS and nothing coarser — a deployment id would be shared by every
    /// replica, which is the case this exists to detect.
    pub instance: String,
}

impl Store {
    /// Postgres when `DATABASE_URL` is set, memory otherwise. An UNSET variable is a deliberate
    /// choice of backend; an EMPTY one is almost always a platform that failed to inject a value,
    /// so it is treated as unset rather than as a connection string that cannot parse.
    pub async fn open() -> Result<Self, String> {
        let instance = Uuid::new_v4().to_string()[..8].to_string();
        let url = std::env::var("DATABASE_URL").ok().filter(|u| !u.trim().is_empty());

        let backend = match url {
            Some(url) => {
                let pool = PgPoolOptions::new()
                    .max_connections(5)
                    .acquire_timeout(Duration::from_secs(10))
                    .connect(&url)
                    .await
                    .map_err(|e| format!("postgres connect failed: {e}"))?;
                Backend::Pg(pool)
            }
            None => Backend::Memory(RwLock::new(HashMap::new())),
        };
        Ok(Self { backend, instance })
    }

    pub fn kind(&self) -> &'static str {
        match self.backend {
            Backend::Memory(_) => "memory",
            Backend::Pg(_) => "postgres",
        }
    }

    pub async fn migrate(&self) -> Result<(), String> {
        match &self.backend {
            Backend::Pg(pool) => sqlx::raw_sql(SCHEMA)
                .execute(pool)
                .await
                .map(|_| ())
                .map_err(|e| format!("migrate failed: {e}")),
            Backend::Memory(_) => Err("--migrate requires DATABASE_URL".into()),
        }
    }

    pub async fn create(&self, question: String) -> Result<Uuid, String> {
        let id = Uuid::new_v4();
        match &self.backend {
            Backend::Memory(m) => {
                let mut runs = m.write().unwrap();
                runs.insert(id, MemRun { question, status: Status::Running, answer: None,
                                         error: None, events: Vec::new(), finished_at: None });
                let now = Instant::now();
                runs.retain(|_, r| r.finished_at.is_none_or(|t| now.duration_since(t) < RETAIN));
            }
            Backend::Pg(pool) => {
                sqlx::query("INSERT INTO run (id, question, status) VALUES ($1, $2, 'running')")
                    .bind(id).bind(&question)
                    .execute(pool).await
                    .map_err(|e| format!("insert run: {e}"))?;
            }
        }
        Ok(id)
    }

    pub async fn append(&self, id: Uuid, kind: &str, payload: String) {
        match &self.backend {
            Backend::Memory(m) => {
                if let Some(run) = m.write().unwrap().get_mut(&id) {
                    let seq = run.events.len() as i32 + 1;
                    run.events.push(Event { seq, kind: kind.into(), payload });
                }
            }
            Backend::Pg(pool) => {
                // The sequence is derived inside the INSERT, so two writers cannot both read the
                // same max and then collide -- the primary key would reject the loser anyway, but
                // computing it in the statement means there is no read-then-write window at all.
                let q = "INSERT INTO run_event (run_id, seq, kind, payload)
                         SELECT $1, COALESCE(MAX(seq), 0) + 1, $2, $3 FROM run_event WHERE run_id = $1";
                if let Err(e) = sqlx::query(q).bind(id).bind(kind).bind(&payload).execute(pool).await {
                    eprintln!("[store] append failed for {id}: {e}");
                }
            }
        }
    }

    pub async fn finish(&self, id: Uuid, status: Status, answer: Option<String>, error: Option<String>) {
        match &self.backend {
            Backend::Memory(m) => {
                if let Some(run) = m.write().unwrap().get_mut(&id) {
                    run.status = status;
                    if answer.is_some() { run.answer = answer; }
                    run.error = error;
                    run.finished_at = Some(Instant::now());
                }
            }
            Backend::Pg(pool) => {
                let q = "UPDATE run SET status = $2, answer = COALESCE($3, answer),
                                error = $4, finished_at = now() WHERE id = $1";
                if let Err(e) = sqlx::query(q).bind(id).bind(status.as_str())
                    .bind(&answer).bind(&error).execute(pool).await {
                    eprintln!("[store] finish failed for {id}: {e}");
                }
            }
        }
    }

    pub async fn read(&self, id: Uuid, after_seq: i32) -> Option<(RunView, Vec<Event>)> {
        match &self.backend {
            Backend::Memory(m) => {
                let runs = m.read().unwrap();
                let run = runs.get(&id)?;
                Some((
                    RunView { id, question: run.question.clone(), status: run.status,
                              answer: run.answer.clone(), error: run.error.clone() },
                    run.events.iter().filter(|e| e.seq > after_seq).cloned().collect(),
                ))
            }
            Backend::Pg(pool) => {
                let row = sqlx::query("SELECT question, status, answer, error FROM run WHERE id = $1")
                    .bind(id).fetch_optional(pool).await.ok().flatten()?;
                let view = RunView {
                    id,
                    question: row.try_get::<String, _>("question").ok()?,
                    status: Status::from_str(&row.try_get::<String, _>("status").ok()?),
                    answer: row.try_get("answer").ok(),
                    error: row.try_get("error").ok(),
                };
                let events = sqlx::query(
                    "SELECT seq, kind, payload FROM run_event WHERE run_id = $1 AND seq > $2 ORDER BY seq")
                    .bind(id).bind(after_seq).fetch_all(pool).await.unwrap_or_default()
                    .into_iter()
                    .filter_map(|r| Some(Event {
                        seq: r.try_get("seq").ok()?,
                        kind: r.try_get("kind").ok()?,
                        payload: r.try_get("payload").ok()?,
                    }))
                    .collect();
                Some((view, events))
            }
        }
    }

    pub async fn counts(&self) -> (i64, i64) {
        match &self.backend {
            Backend::Memory(m) => {
                let runs = m.read().unwrap();
                (runs.len() as i64, runs.values().filter(|r| !r.status.is_terminal()).count() as i64)
            }
            Backend::Pg(pool) => {
                let q = "SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status = 'running') AS active FROM run";
                match sqlx::query(q).fetch_one(pool).await {
                    Ok(r) => (r.try_get("total").unwrap_or(0), r.try_get("active").unwrap_or(0)),
                    Err(_) => (0, 0),
                }
            }
        }
    }
}
