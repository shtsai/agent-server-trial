"use client";
import { useEffect, useRef, useState } from "react";

type Event = { seq: number; kind: string; payload: string };
type Phase = "idle" | "running" | "done" | "partial" | "failed" | "lost" | "unreachable";

const TERMINAL: Phase[] = ["done", "partial", "failed", "lost", "unreachable"];

const C = {
  bg: "#12161b", line: "#2a2f36", dim: "#7f8b98", mid: "#9aa4af", fg: "#e6e8eb",
  errBg: "#2a1416", errFg: "#f8a0a6", warnBg: "#2a2314", warnFg: "#f2ce7a", accent: "#2563eb",
};

export default function Page() {
  const [question, setQuestion] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [detail, setDetail] = useState<string>("");
  const [events, setEvents] = useState<Event[]>([]);
  // The instance that CREATED the run, against the instance answering each poll. With run state in
  // memory these must be the same container; a difference is the platform having scaled out, which
  // is precisely the failure this shape has and which nothing else would show you.
  const [bornOn, setBornOn] = useState<string | null>(null);
  const [servedBy, setServedBy] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    if (!runId || TERMINAL.includes(phase)) return;
    let cancelled = false;

    const tick = async () => {
      const res = await fetch(`/api/runs/${runId}?after=${seq.current}`, { cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (cancelled || !data) return;

      if (data.instance) setServedBy(data.instance);

      if (res.status === 404 && data.lost) { setPhase("lost"); setDetail(data.reason); return; }
      if (data.unreachable) { setPhase("unreachable"); setDetail(data.reason); return; }
      if (!res.ok || !data.run) return;

      if (data.events?.length) {
        seq.current = data.events[data.events.length - 1].seq;
        setEvents((prev) => [...prev, ...data.events]);
      }
      setPhase(data.run.status as Phase);
      setDetail(data.run.error ?? "");
    };

    const t = setInterval(tick, 1000);
    void tick();
    return () => { cancelled = true; clearInterval(t); };
  }, [runId, phase]);

  const submit = async () => {
    setEvents([]); seq.current = 0; setDetail(""); setPhase("running");
    setBornOn(null); setServedBy(null); setRunId(null);
    const res = await fetch("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question }),
    });
    const run = await res.json().catch(() => null);
    if (!res.ok || !run?.id) {
      setPhase(run?.unreachable ? "unreachable" : "failed");
      setDetail(run?.reason ?? run?.error ?? `agent returned ${res.status}`);
      return;
    }
    setBornOn(run.instance); setServedBy(run.instance);
    setRunId(run.id);
  };

  const drifted = bornOn && servedBy && bornOn !== servedBy;

  // The failure that has no run id is the one that matters most: a POST that never got an id has
  // nothing to poll and no section to render into, so a page gated entirely on `runId` computes
  // the error and then shows the reader a blank screen. Status nobody can see is not status.
  const blocked = !runId && (phase === "unreachable" || phase === "failed");

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "3rem 1.5rem" }}>
      <h1 style={{ fontSize: 20, letterSpacing: -0.2 }}>agent-server-trial</h1>
      <p style={{ color: C.mid, fontSize: 14, lineHeight: 1.6 }}>
        No database. The run lives in the agent container's memory, so a refresh re-attaches to it
        and a restart destroys it — and the container's id is printed below so you can see which of
        those happened.
      </p>

      <div style={{ display: "flex", gap: 8, marginTop: 24 }}>
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && question.trim()) void submit(); }}
          placeholder="Ask something…"
          style={{ flex: 1, padding: "10px 12px", borderRadius: 8, border: `1px solid ${C.line}`,
                   background: C.bg, color: "inherit", fontSize: 14 }}
        />
        <button
          onClick={submit}
          disabled={!question.trim()}
          style={{ padding: "10px 16px", borderRadius: 8, border: `1px solid ${C.line}`,
                   background: question.trim() ? C.accent : "#1a1f26", color: "#fff",
                   fontSize: 14, cursor: question.trim() ? "pointer" : "not-allowed" }}
        >
          Run
        </button>
      </div>

      {blocked && (
        <Banner tone="err">
          <strong>Could not start a run.</strong>
          <div style={{ marginTop: 6, fontFamily: "ui-monospace, monospace", fontSize: 12 }}>
            {detail}
          </div>
        </Banner>
      )}

      {runId && (
        <section style={{ marginTop: 32 }}>
          <div style={{ fontSize: 12, color: C.mid, fontFamily: "ui-monospace, monospace" }}>
            {runId} · <strong style={{ color: C.fg }}>{phase}</strong>
            {servedBy && <> · container <strong style={{ color: C.fg }}>{servedBy}</strong></>}
          </div>

          {drifted && (
            <Banner tone="warn">
              This poll was answered by container <code>{servedBy}</code>, but the run was created on{" "}
              <code>{bornOn}</code>. The platform is running more than one replica — with state in
              memory, that is the bug this shape has.
            </Banner>
          )}
          {phase === "lost" && <Banner tone="err">{detail}</Banner>}
          {phase === "unreachable" && (
            <Banner tone="err">Could not reach the agent service: {detail}</Banner>
          )}
          {phase === "partial" && (
            <Banner tone="warn">
              Partial: the steps below are real, but the run did not finish. {detail}
            </Banner>
          )}
          {phase === "failed" && detail && <Banner tone="err">{detail}</Banner>}

          <ol style={{ listStyle: "none", padding: 0, marginTop: 16, display: "grid", gap: 12 }}>
            {events.map((e) => (
              <li key={e.seq} style={{ padding: 12, borderRadius: 8, border: `1px solid ${C.line}`,
                                       background: e.kind === "error" ? C.errBg : C.bg }}>
                <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6,
                              color: e.kind === "error" ? C.errFg : C.dim }}>{e.kind}</div>
                <div style={{ fontSize: 14, lineHeight: 1.6, marginTop: 6, whiteSpace: "pre-wrap" }}>
                  {e.payload}
                </div>
              </li>
            ))}
          </ol>

          {events.length === 0 && phase === "running" && (
            <p style={{ color: C.dim, fontSize: 14 }}>Working — first step takes a few seconds…</p>
          )}
        </section>
      )}
    </main>
  );
}

function Banner({ tone, children }: { tone: "err" | "warn"; children: React.ReactNode }) {
  const bg = tone === "err" ? C.errBg : C.warnBg;
  const fg = tone === "err" ? C.errFg : C.warnFg;
  return (
    <div style={{ marginTop: 16, padding: 12, borderRadius: 8, border: `1px solid ${fg}33`,
                  background: bg, color: fg, fontSize: 13, lineHeight: 1.6 }}>
      {children}
    </div>
  );
}
