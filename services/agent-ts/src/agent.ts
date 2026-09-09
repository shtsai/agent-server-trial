import Anthropic from "@anthropic-ai/sdk";
import { appendEvent, finishRun, heartbeat, type Run } from "./store.js";

const MODEL = "claude-haiku-4-5-20251001"; // cheapest tier -- iterating must be free
const STEPS = 3;

/** The Python service exists to prove the polyglot boundary, not to be clever. */
async function callDocService(text: string): Promise<string> {
  const base = process.env.DOC_SERVICE_URL;
  if (!base) return "doc service not configured";
  const res = await fetch(`${base}/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(10_000), // every outbound call gets a deadline
  });
  if (!res.ok) throw new Error(`doc service ${res.status}`);
  return JSON.stringify(await res.json());
}

/**
 * A deliberately slow, multi-step loop -- the point is that it takes long enough to be killed
 * halfway through, so the restart behaviour is observable on both platforms.
 */
export async function runAgent(run: Run, signal?: AbortSignal) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const notes: string[] = [];

  try {
    const stats = await callDocService(run.question);
    await appendEvent(run.id, "step", `python service: ${stats}`);

    for (let i = 1; i <= STEPS; i++) {
      if (signal?.aborted) return finishRun(run.id, "cancelled");
      await heartbeat(run.id);

      const msg = await client.messages.create(
        {
          model: MODEL,
          max_tokens: 400,
          messages: [{
            role: "user",
            content: `Question: ${run.question}\n\nNotes so far:\n${notes.join("\n") || "(none)"}\n\n` +
              (i < STEPS
                ? `Write ONE short additional consideration (step ${i} of ${STEPS}). No preamble.`
                : `Now write the final answer in under 120 words.`),
          }],
        },
        { signal },
      );

      const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();

      // A truncated reply often still parses and reads as a complete answer that found less.
      if (msg.stop_reason === "max_tokens") await appendEvent(run.id, "note", "reply hit max_tokens");

      if (i < STEPS) {
        notes.push(text);
        await appendEvent(run.id, "step", text);
      } else {
        await appendEvent(run.id, "answer", text);
        await finishRun(run.id, "done", { answer: text });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await appendEvent(run.id, "error", message);
    // Partial work is a PARTIAL, never a silent success and never a bare failure.
    await finishRun(run.id, notes.length ? "partial" : "failed", { error: message });
  }
}
