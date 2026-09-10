//! The agent loop. Three steps, deliberately slow, so there is a window in which to kill the
//! container and watch what each platform does with the run that was in flight.
//!
//! It calls the Anthropic Messages API directly over `reqwest` -- there is no official Rust SDK,
//! and one HTTP call does not earn a dependency.

use crate::store::{Status, Store};
use serde::Deserialize;
use std::sync::Arc;
use std::time::Duration;
use uuid::Uuid;

/// The cheapest tier. Iterating must be structurally free, not carefully free.
const MODEL: &str = "claude-haiku-4-5-20251001";
const STEPS: usize = 3;
/// Every outbound call gets a deadline. A hung upstream otherwise pins a run in `running` for as
/// long as the platform lets the container live.
const CALL_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Deserialize)]
struct Message {
    content: Vec<Block>,
    stop_reason: Option<String>,
}

#[derive(Deserialize)]
struct Block {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    text: String,
}

async fn ask(http: &reqwest::Client, key: &str, prompt: &str) -> Result<(String, bool), String> {
    let res = http
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .timeout(CALL_TIMEOUT)
        .json(&serde_json::json!({
            "model": MODEL,
            "max_tokens": 400,
            "messages": [{ "role": "user", "content": prompt }],
        }))
        .send()
        .await
        .map_err(|e| format!("anthropic request failed: {e}"))?;

    let status = res.status();
    if !status.is_success() {
        // Carry the body: a 400 from this API says exactly what is wrong, and swallowing it into
        // "request failed" is how an afternoon goes missing.
        let body = res.text().await.unwrap_or_default();
        return Err(format!("anthropic {status}: {}", body.chars().take(300).collect::<String>()));
    }

    let msg: Message = res.json().await.map_err(|e| format!("anthropic decode failed: {e}"))?;
    let text = msg
        .content
        .iter()
        .filter(|b| b.kind == "text")
        .map(|b| b.text.as_str())
        .collect::<String>()
        .trim()
        .to_string();

    // A truncated reply still parses, and then reads as a complete answer that simply found less.
    // Check the stop reason BEFORE trusting the text.
    Ok((text, msg.stop_reason.as_deref() == Some("max_tokens")))
}

/// Runs to completion, writing every step into the store as it goes. Detached from the request
/// that created it -- which is itself one of the things under test: a Vercel Service container
/// keeps running between requests until it scales down, and whether a detached task actually
/// makes progress there is a question the marketing does not answer.
pub async fn run(store: Arc<Store>, id: Uuid, question: String) {
    let Ok(key) = std::env::var("ANTHROPIC_API_KEY") else {
        store.append(id, "error", "ANTHROPIC_API_KEY is not set".into());
        store.finish(id, Status::Failed, None, Some("ANTHROPIC_API_KEY is not set".into()));
        return;
    };
    let http = reqwest::Client::new();
    let mut notes: Vec<String> = Vec::new();

    for i in 1..=STEPS {
        let prompt = if i < STEPS {
            format!(
                "Question: {question}\n\nNotes so far:\n{}\n\nWrite ONE short additional \
                 consideration (step {i} of {STEPS}). No preamble.",
                if notes.is_empty() { "(none)".into() } else { notes.join("\n") }
            )
        } else {
            format!(
                "Question: {question}\n\nNotes so far:\n{}\n\nNow write the final answer in under \
                 120 words.",
                notes.join("\n")
            )
        };

        match ask(&http, &key, &prompt).await {
            Ok((text, truncated)) => {
                if truncated {
                    store.append(id, "note", "reply hit max_tokens".into());
                }
                if i < STEPS {
                    notes.push(text.clone());
                    store.append(id, "step", text);
                } else {
                    store.append(id, "answer", text.clone());
                    store.finish(id, Status::Done, Some(text), None);
                }
            }
            Err(e) => {
                store.append(id, "error", e.clone());
                // Work already done is a PARTIAL. Never a silent success, never a bare failure --
                // the caller has to be able to tell "it got two thirds of the way" from "it never
                // started", because those need opposite work.
                let status = if notes.is_empty() { Status::Failed } else { Status::Partial };
                store.finish(id, status, None, Some(e));
                return;
            }
        }
    }
}
