"use client";
import { useEffect, useRef, useState } from "react";

type Event = { seq: number; kind: string; payload: string };

export default function Page() {
  const [question, setQuestion] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("");
  const [events, setEvents] = useState<Event[]>([]);
  const seq = useRef(0);

  // Polling the run, not holding a connection to it. A refresh loses nothing: the run outlives
  // the request that created it, which is the whole property under test.
  useEffect(() => {
    if (!runId) return;
    const tick = async () => {
      const res = await fetch(`/api/runs/${runId}?after=${seq.current}`);
      if (!res.ok) return;
      const data = await res.json();
      setStatus(data.run.status);
      if (data.events.length) {
        seq.current = data.events[data.events.length - 1].seq;
        setEvents((prev) => [...prev, ...data.events]);
      }
    };
    const t = setInterval(tick, 1000);
    void tick();
    return () => clearInterval(t);
  }, [runId]);

  const submit = async () => {
    setEvents([]); seq.current = 0; setStatus("queued");
    const res = await fetch("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question }),
    });
    const run = await res.json();
    setRunId(run.id);
  };

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "3rem 1.5rem" }}>
      <h1 style={{ fontSize: 20, letterSpacing: -0.2 }}>agent-server-trial</h1>
      <p style={{ color: "#9aa4af", fontSize: 14, lineHeight: 1.6 }}>
        Submit a question. The run is persisted before any work starts, so you can refresh this page
        or kill the worker and watch what happens.
      </p>

      <div style={{ display: "flex", gap: 8, marginTop: 24 }}>
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask something…"
          style={{ flex: 1, padding: "10px 12px", borderRadius: 8, border: "1px solid #2a2f36",
                   background: "#12161b", color: "inherit", fontSize: 14 }}
        />
        <button
          onClick={submit}
          disabled={!question.trim()}
          style={{ padding: "10px 16px", borderRadius: 8, border: "1px solid #2a2f36",
                   background: question.trim() ? "#2563eb" : "#1a1f26", color: "#fff",
                   fontSize: 14, cursor: question.trim() ? "pointer" : "not-allowed" }}
        >
          Run
        </button>
      </div>

      {runId && (
        <section style={{ marginTop: 32 }}>
          <div style={{ fontSize: 12, color: "#9aa4af", fontFamily: "ui-monospace, monospace" }}>
            {runId} · <strong style={{ color: "#e6e8eb" }}>{status}</strong>
          </div>
          <ol style={{ listStyle: "none", padding: 0, marginTop: 16, display: "grid", gap: 12 }}>
            {events.map((e) => (
              <li key={e.seq} style={{ padding: 12, borderRadius: 8, border: "1px solid #2a2f36",
                                       background: e.kind === "error" ? "#2a1416" : "#12161b" }}>
                <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6,
                              color: e.kind === "error" ? "#f8a0a6" : "#7f8b98" }}>{e.kind}</div>
                <div style={{ fontSize: 14, lineHeight: 1.6, marginTop: 6, whiteSpace: "pre-wrap" }}>{e.payload}</div>
              </li>
            ))}
          </ol>
          {events.length === 0 && (
            <p style={{ color: "#7f8b98", fontSize: 14 }}>
              Waiting for a worker to claim this run…
            </p>
          )}
        </section>
      )}
    </main>
  );
}
