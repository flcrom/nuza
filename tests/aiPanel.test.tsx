import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import SetupChecklist from "../src/components/AiPanel/SetupChecklist";
import TurnView from "../src/components/AiPanel/TurnView";
import Composer from "../src/components/AiPanel/Composer";
import ThreadList from "../src/components/AiPanel/ThreadList";
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
    text: "Tighten this up",
    action: null,
    about: { title: "release.md", lines: "L9-10" },
    intent: "ask",
    context: null,
    answer: events.reduce(applyEvent, emptyAnswer()),
    edits: null,
    startedAt: 0,
    took: 12_000,
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
  test("carries no name label - and where it is named, it is the agent's own name, never nuza's", () => {
    const markup = render(
      [
        { kind: "refused", action: "run a command" },
        { kind: "token", text: "Shorter." },
        { kind: "done", stop_reason: "end_turn" },
      ],
      "Codex"
    );
    expect(markup).toContain("Shorter.");
    expect(markup).not.toMatch(/>Codex</);
    expect(markup).toContain("nuza didn&#x27;t let Codex run a command.");
  });

  test("the writer's message shows the note and lines it is about, then their words", () => {
    const markup = render([]);
    expect(markup).toContain("release.md");
    expect(markup).toContain("#L9-10");
    expect(markup).toContain("Tighten this up");
  });

  test("thinking and steps fold into one line that says how long it took", () => {
    const markup = render([
      { kind: "thought", text: "Hm." },
      { kind: "step", id: "s", title: "mcp__nuza__search_vault", status: "completed" },
      { kind: "token", text: "Found it." },
      { kind: "done", stop_reason: "end_turn" },
    ]);
    expect(markup).toContain("Worked for 12s");
    expect(markup).toContain("Searched the vault");
    // Folded away once the answer is there.
    expect(markup).toContain('<details class="group');
    expect(markup).not.toMatch(/<details[^>]* open/);
  });

  test("a code block has its language and a copy button", () => {
    const markup = render([{ kind: "token", text: "```ts\nconst a = 1;\n```" }]);
    expect(markup).toContain(">ts<");
    expect(markup).toContain('aria-label="Copy the code"');
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

  test("while it starts, says it is thinking", () => {
    expect(render([])).toContain("Thinking…");
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

describe("the composer", () => {
  const props = {
    value: "",
    onChange: () => {},
    onSend: () => {},
    onStop: () => {},
    onAction: () => {},
    onEscape: () => {},
    onFocus: () => {},
    running: false,
    intent: "ask" as const,
    selected: false,
    onWord: false,
    models: [
      { id: "haiku", name: "Haiku 5.5", description: "" },
      { id: "opus", name: "Opus 5.5", description: "" },
    ],
    model: "haiku",
    onModel: () => {},
    used: 3,
  };

  test("shows the model's name with its arrow right after it", () => {
    const markup = renderToStaticMarkup(<Composer {...props} />);
    expect(markup).toMatch(/<span class="truncate">Haiku 5\.5<\/span><svg[^>]*lucide-chevron-up/);
    expect(markup).not.toContain("Default model");
  });

  test("says what the context figure means", () => {
    const markup = renderToStaticMarkup(<Composer {...props} />);
    expect(markup).toContain("3% context");
    expect(markup).toContain("This conversation fills 3% of what the agent can keep in mind at once");
  });
});

describe("the list of chats", () => {
  const now = Date.now();
  const threads = [
    { id: "a", title: "Is the timeline realistic?", updatedAt: now - 5 * 60_000, turns: [] },
    { id: "b", title: "Synonym · weblog.md", updatedAt: now - 2 * 86_400_000, turns: [] },
  ];

  test("shows each with when it was last used, and a way to delete it", () => {
    const markup = renderToStaticMarkup(
      <ThreadList threads={threads} current="a" onOpen={() => {}} onDelete={() => {}} onClose={() => {}} />
    );
    expect(markup).toContain("Is the timeline realistic?");
    expect(markup).toContain("5m ago");
    expect(markup).toContain("2d ago");
    expect(markup).toContain('aria-label="Delete “Synonym · weblog.md”"');
    expect(markup).toContain("Chats untouched for 7 days are deleted");
  });

  test("says so when there are none", () => {
    const markup = renderToStaticMarkup(
      <ThreadList threads={[]} current="x" onOpen={() => {}} onDelete={() => {}} onClose={() => {}} />
    );
    expect(markup).toContain("No earlier chats in this folder.");
  });
});

describe("a new note the agent suggested", () => {
  const withNote = (status: "pending" | "created" | "failed", error: string | null = null) =>
    renderToStaticMarkup(
      <TurnView
        turn={{
          ...turn([
            { kind: "token", text: "Here is a note for the launch." },
            { kind: "done", stop_reason: "end_turn" },
          ]),
          notes: [
            {
              id: "note-1-0",
              path: "ideas/launch.md",
              content: "---\ntags: [launch]\n---\n# Launch\n\nSee [[release]].",
              why: "As asked.",
              status,
              error,
            },
          ],
        }}
        agent="OpenCode"
        actions={{ onRetry: () => {}, onOpenSettings: () => {} }}
      />
    );

  test("shows where it would go and what it says, to create or discard", () => {
    const markup = withNote("pending");
    expect(markup).toContain("New note");
    expect(markup).toContain("ideas/launch.md");
    expect(markup).toContain("tags: [launch]");
    expect(markup).toContain(">Create<");
    expect(markup).toContain(">Discard<");
  });

  test("once made, says so and offers nothing more", () => {
    const markup = withNote("created");
    expect(markup).toContain("Created");
    expect(markup).not.toContain(">Create<");
  });

  test("when it could not be made, says why and can be tried again", () => {
    const markup = withNote("failed", '"ideas/launch.md" already exists');
    expect(markup).toContain("already exists");
    expect(markup).toContain(">Create<");
  });
});
