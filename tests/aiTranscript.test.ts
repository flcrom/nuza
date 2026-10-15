import { describe, expect, test } from "bun:test";
import { answerText, applyEvent, contextUsed, emptyAnswer, type Answer } from "../src/lib/ai/transcript";
import type { AgentEvent } from "../src/lib/ai/protocol";

function after(events: AgentEvent[]): Answer {
  return events.reduce(applyEvent, emptyAnswer());
}

describe("an answer, as it streams", () => {
  test("runs of words are joined, and a step between them stays between them", () => {
    const answer = after([
      { kind: "token", text: "Let me " },
      { kind: "token", text: "check." },
      { kind: "step", id: "s1", title: "Read releases.md", status: "pending" },
      { kind: "token", text: " Done." },
    ]);
    expect(answer.parts).toEqual([
      { type: "text", text: "Let me check." },
      { type: "step", id: "s1", title: "Read releases.md", status: "pending" },
      { type: "text", text: " Done." },
    ]);
    expect(answerText(answer)).toBe("Let me check. Done.");
  });

  test("a step's update keeps what it did not say", () => {
    const answer = after([
      { kind: "step", id: "s1", title: "Search the vault", status: "pending" },
      { kind: "token", text: "…" },
      { kind: "step", id: "s1", title: null, status: "completed" },
    ]);
    expect(answer.parts[0]).toEqual({
      type: "step",
      id: "s1",
      title: "Search the vault",
      status: "completed",
    });
    expect(answer.parts).toHaveLength(2);
  });

  test("thoughts are kept apart from the words", () => {
    const answer = after([
      { kind: "thought", text: "Hm, " },
      { kind: "thought", text: "the dates." },
      { kind: "token", text: "March." },
    ]);
    expect(answer.parts[0]).toEqual({ type: "thought", text: "Hm, the dates." });
    expect(answerText(answer)).toBe("March.");
  });

  test("a refusal and a notice each take a line of their own", () => {
    const answer = after([
      { kind: "refused", action: "run a command" },
      { kind: "notice", text: "Claude Code started a fresh conversation." },
    ]);
    expect(answer.parts).toEqual([
      { type: "refused", action: "run a command" },
      { type: "notice", text: "Claude Code started a fresh conversation." },
    ]);
  });

  test("the end of a turn is recorded with its reason", () => {
    expect(after([{ kind: "done", stop_reason: "cancelled" }])).toMatchObject({
      state: "done",
      stopReason: "cancelled",
    });
    const failed = after([
      { kind: "token", text: "Partial" },
      { kind: "failed", code: "adapter_crashed", message: "Claude Code stopped unexpectedly." },
    ]);
    expect(failed.state).toBe("failed");
    expect(failed.error?.code).toBe("adapter_crashed");
    // What was said before it failed is kept.
    expect(answerText(failed)).toBe("Partial");
  });

  test("the context in use is the agent's own number, as a percentage", () => {
    expect(contextUsed(emptyAnswer())).toBeNull();
    expect(contextUsed(after([{ kind: "usage", used: 68000, size: 200000 }]))).toBe(34);
    expect(contextUsed(after([{ kind: "usage", used: 5, size: 0 }]))).toBeNull();
  });

  test("taking an event in never changes the answer it was given", () => {
    const before = after([{ kind: "token", text: "a" }]);
    const snapshot = JSON.stringify(before);
    applyEvent(before, { kind: "token", text: "b" });
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});
