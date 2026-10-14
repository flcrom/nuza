import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import SetupChecklist from "../src/components/AiPanel/SetupChecklist";
import TurnView from "../src/components/AiPanel/TurnView";
import type { ChatTurn } from "../src/hooks/useAiChat";
import type { AgentErrorKind, Detection } from "../src/lib/ai/protocol";
import { applyEvent, emptyAnswer } from "../src/lib/ai/transcript";
import type { AgentEvent } from "../src/lib/ai/protocol";

const nothing: Detection = {
  node: "v24.0.0",
  agents: [
    { id: "claude-code", path: "/opt/homebrew/bin/claude", version: "2.1.0", signedIn: null },
    { id: "codex", path: null, version: null, signedIn: null },
    { id: "opencode", path: null, version: null, signedIn: null },
  ],
};

function turn(events: AgentEvent[]): ChatTurn {
  return {
    id: 1,
    question: "Tighten this up",
    intent: "ask",
    context: null,
    sent: "the exact prompt",
    answer: events.reduce(applyEvent, emptyAnswer()),
  };
}

const actions = { onRetry() {}, onOpenSettings() {} };
const render = (events: AgentEvent[], agent = "Claude Code") =>
  renderToStaticMarkup(<TurnView turn={turn(events)} agent={agent} actions={actions} />);

describe("the panel with no agent turned on", () => {
  const markup = renderToStaticMarkup(
    <SetupChecklist
      detection={nothing}
      starting={null}
      error={null}
      onUse={() => {}}
      onOpenSettings={() => {}}
    />
  );

  test("says what this is, with nothing to sign up for", () => {
    expect(markup).toContain("Bring your own agent");
    expect(markup).toContain("nothing to");
  });

  test("offers the agent that is installed, and the install line for the rest", () => {
    expect(markup.match(/Use it/g)).toHaveLength(1);
    expect(markup).toContain("npm install -g @openai/codex");
    expect(markup).toContain("Something else");
  });

  test("while looking, says nothing is missing yet", () => {
    const looking = renderToStaticMarkup(
      <SetupChecklist
        detection={null}
        starting={null}
        error={null}
        onUse={() => {}}
        onOpenSettings={() => {}}
      />
    );
    expect(looking).not.toContain("Not found");
    expect(looking).not.toContain("Use it");
  });
});

describe("an answer in the panel", () => {
  test("is signed with the agent's own name, never nuza's", () => {
    const markup = render(
      [
        { kind: "token", text: "Shorter." },
        { kind: "done", stop_reason: "end_turn" },
      ],
      "Codex"
    );
    expect(markup).toContain(">Codex<");
    expect(markup).toContain("Shorter.");
  });

  test("shows what was sent, word for word, folded away", () => {
    expect(render([])).toContain("What was sent");
    expect(render([])).toContain("the exact prompt");
  });

  test("while it starts, says who is being asked", () => {
    expect(render([])).toContain("Asking Claude Code");
  });

  test("a step is a line, ticked when it is done", () => {
    const working = render([{ kind: "step", id: "s", title: "Read releases.md", status: "pending" }]);
    expect(working).toContain("Read releases.md");
    expect(working).toContain('aria-label="Working"');
    const done = render([
      { kind: "step", id: "s", title: "Read releases.md", status: "pending" },
      { kind: "step", id: "s", title: null, status: "completed" },
    ]);
    expect(done).toContain('aria-label="Done"');
  });

  test("a refusal is one line, and the answer carries on", () => {
    const markup = render([
      { kind: "refused", action: "run a command" },
      { kind: "token", text: "I can't run that here." },
    ]);
    expect(markup).toContain("nuza didn&#x27;t let Claude Code run a command.");
    expect(markup).toContain("I can&#x27;t run that here.");
    expect(markup).not.toContain('role="alert"');
  });

  test("stopping keeps what was said", () => {
    const markup = render([
      { kind: "token", text: "The first half" },
      { kind: "done", stop_reason: "cancelled" },
    ]);
    expect(markup).toContain("The first half");
    expect(markup).toContain("Stopped.");
  });

  test("an answer with nothing in it is said to be one", () => {
    expect(render([{ kind: "done", stop_reason: "end_turn" }])).toContain("finished without saying anything");
  });
});

describe("a failed answer has its fix next to it", () => {
  const failed = (code: AgentErrorKind, message: string) => render([{ kind: "failed", code, message }]);

  test("an agent that will not start points at its settings", () => {
    expect(failed("agent_missing", "Couldn't start Claude Code.")).toContain("Open AI settings");
  });

  test("a crash and a hang can be retried", () => {
    expect(failed("adapter_crashed", "Claude Code stopped unexpectedly.")).toContain("Retry");
    expect(failed("timeout", "Claude Code stopped responding.")).toContain("Retry");
  });

  test("a usage limit is the plan's, with nothing to sell", () => {
    const markup = failed("usage_limit", "You've hit Claude Code's usage limit. Try again once it resets.");
    expect(markup).toContain("usage limit");
    expect(markup).not.toContain("Retry");
    expect(markup).not.toMatch(/upgrade|buy|subscribe/i);
  });

  test("every failure is said where it happened, not in a toast", () => {
    expect(failed("other", "the network is unreachable")).toContain('role="alert"');
  });
});
