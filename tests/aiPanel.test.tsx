import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import SetupChecklist from "../src/components/AiPanel/SetupChecklist";
import TurnView from "../src/components/AiPanel/TurnView";
import type { ChatTurn, EditCard, TurnEdits } from "../src/hooks/useAiChat";
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
    answer: events.reduce(applyEvent, emptyAnswer()),
    edits: null,
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

  test("never shows nuza's own instructions to the agent", () => {
    const markup = render([
      {
        kind: "token",
        text: "You said: You are Claude Code, helping someone with a note in nuza, a markdown notes app on their computer.\n\n",
      },
      { kind: "token", text: '<note id="e72bcccb7ec">\nShip it.\n</note id="e72bcccb7ec">' },
      { kind: "done", stop_reason: "end_turn" },
    ]);
    expect(markup).not.toContain("What was sent");
    expect(markup).not.toContain("helping someone with a note in nuza");
    expect(markup).not.toContain("e72bcccb7ec");
    expect(markup).toContain("Ship it.");
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

describe("an answer that proposes edits", () => {
  const withEdits = (cards: EditCard[], extra: Partial<TurnEdits> = {}) =>
    renderToStaticMarkup(
      <TurnView
        turn={{
          ...turn([
            { kind: "token", text: 'Cut the hedging.\n\n```nuza-edits\n[{"find":"a","replace":"b"}]\n```' },
            { kind: "done", stop_reason: "end_turn" },
          ]),
          edits: { path: "/v/plan.md", cards, aligning: false, shown: true, problem: null, ...extra },
        }}
        agent="Claude Code"
        actions={actions}
      />
    );
  const card = (id: string, status: EditCard["status"] = "pending"): EditCard => ({
    id,
    find: "It is probably the case that the release will slip.",
    replace: "The release slips.",
    why: "Cut the hedging.",
    status,
  });

  test("shows the prose, and the edits as cards rather than the JSON they came in", () => {
    const markup = withEdits([card("a")]);
    expect(markup).toContain("Cut the hedging.");
    expect(markup).not.toContain("nuza-edits");
    expect(markup).not.toContain("&quot;find&quot;");
    expect(markup).toContain("Proposed edit 1 of 1");
    expect(markup).toContain("The release slips.");
  });

  test("a card can be accepted or rejected while it waits, and says how it went after", () => {
    expect(withEdits([card("a")])).toContain(">Accept<");
    const decided = withEdits([card("a", "accepted"), card("b", "stale")]);
    expect(decided).toContain("Accepted");
    expect(decided).toContain("This no longer matches the note");
    expect(decided).not.toContain(">Accept<");
  });

  test("two or more waiting can be taken or dropped together", () => {
    expect(withEdits([card("a"), card("b")])).toContain("Accept all");
    expect(withEdits([card("a")])).not.toContain("Accept all");
  });

  test("while the one retry runs, says what it is doing", () => {
    expect(withEdits([], { aligning: true })).toContain("Lining the changes up with your note");
  });

  test("edits for a note that is not open offer to show it", () => {
    expect(withEdits([card("a")], { shown: false })).toContain("Show in the note");
  });

  test("a block still being written is not shown as JSON", () => {
    const markup = render([{ kind: "token", text: 'Sure.\n\n```nuza-edits\n[{"find": "It is' }]);
    expect(markup).toContain("Sure.");
    expect(markup).toContain("Writing the changes");
    expect(markup).not.toContain("nuza-edits");
  });
});
