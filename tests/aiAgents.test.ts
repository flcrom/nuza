import { describe, expect, test } from "bun:test";
import {
  CLAUDE_ADAPTER,
  CODEX_ADAPTER,
  PRESETS,
  presetFor,
  readiness,
  sameAgent,
  splitArgs,
  splitDirs,
} from "../src/lib/ai/agents";
import { chooseModel, modelFor, NO_MODEL_CHOICES } from "../src/lib/ai/modelChoice";
import type { Detection } from "../src/lib/ai/protocol";

const nothing: Detection = {
  node: null,
  agents: [
    { id: "claude-code", path: null, version: null, signedIn: null },
    { id: "codex", path: null, version: null, signedIn: null },
    { id: "opencode", path: null, version: null, signedIn: null },
  ],
};

function withAgent(
  id: "claude-code" | "codex" | "opencode",
  node: string | null,
  signedIn: boolean | null = null
) {
  return {
    node,
    agents: nothing.agents.map((found) =>
      found.id === id ? { ...found, path: `/usr/local/bin/${id}`, version: "1.0.0", signedIn } : found
    ),
  } satisfies Detection;
}

describe("the agents nuza knows", () => {
  test("adapters are pinned to an exact version", () => {
    for (const pin of [CLAUDE_ADAPTER, CODEX_ADAPTER]) {
      expect(pin).toMatch(/@\d+\.\d+\.\d+$/);
    }
  });

  test("what each one runs is shown, pin and all", () => {
    expect(presetFor({ kind: "claudeCode" })?.runs).toContain(CLAUDE_ADAPTER);
    expect(presetFor({ kind: "codex" })?.runs).toContain(CODEX_ADAPTER);
    expect(presetFor({ kind: "openCode" })?.runs).toBe("opencode acp");
    expect(presetFor({ kind: "custom", command: "x", args: [], dataDirs: [] })).toBeUndefined();
    expect(presetFor(null)).toBeUndefined();
  });

  test("every preset says how to install it and how to sign in", () => {
    for (const preset of PRESETS) {
      expect(preset.install.length).toBeGreaterThan(0);
      expect(preset.signIn.length).toBeGreaterThan(0);
    }
  });
});

describe("whether an agent can be used here", () => {
  test("before anything has been looked for, nobody knows", () => {
    expect(readiness(PRESETS[0], null)).toEqual({ state: "unknown" });
  });

  test("on a computer with nothing installed, every agent is missing", () => {
    for (const preset of PRESETS) expect(readiness(preset, nothing).state).toBe("missing");
  });

  test("an agent run through npx is not ready without Node", () => {
    const claude = PRESETS.find((preset) => preset.id === "claude-code")!;
    expect(readiness(claude, withAgent("claude-code", null)).state).toBe("needs-node");
    expect(readiness(claude, withAgent("claude-code", "v24.0.0")).state).toBe("found");
  });

  test("an agent with its own ACP needs no Node", () => {
    const opencode = PRESETS.find((preset) => preset.id === "opencode")!;
    expect(readiness(opencode, withAgent("opencode", null)).state).toBe("found");
  });

  test("a login state nuza cannot read is passed on as unknown, not signed out", () => {
    const claude = PRESETS.find((preset) => preset.id === "claude-code")!;
    const found = readiness(claude, withAgent("claude-code", "v24.0.0"));
    expect(found).toMatchObject({ state: "found", signedIn: null });
    const codex = PRESETS.find((preset) => preset.id === "codex")!;
    expect(readiness(codex, withAgent("codex", "v24.0.0", false))).toMatchObject({ signedIn: false });
  });
});

describe("a custom agent", () => {
  test("its arguments are split the way they were typed, quotes kept whole", () => {
    expect(splitArgs(`~/agents/mine.js --name "my agent" 'two words'`)).toEqual([
      "~/agents/mine.js",
      "--name",
      "my agent",
      "two words",
    ]);
    expect(splitArgs("   ")).toEqual([]);
  });

  test("its folders are one per line or comma, blanks left out", () => {
    expect(splitDirs("~/.a\n\n ~/.b , ~/.c ")).toEqual(["~/.a", "~/.b", "~/.c"]);
  });

  test("changing anything about what runs makes it a different agent", () => {
    const one = { kind: "custom" as const, command: "node", args: ["a.js"], dataDirs: [] };
    expect(sameAgent(one, { ...one, command: " node " })).toBe(true);
    expect(sameAgent(one, { ...one, args: ["b.js"] })).toBe(false);
    expect(sameAgent(one, { ...one, dataDirs: ["~/.x"] })).toBe(false);
    expect(sameAgent({ kind: "codex" }, { kind: "codex" })).toBe(true);
    expect(sameAgent({ kind: "codex" }, null)).toBe(false);
  });
});

describe("the model chosen for a vault", () => {
  test("is kept per vault", () => {
    const codex = { kind: "codex" as const };
    let choices = chooseModel(NO_MODEL_CHOICES, codex, "/notes/work", "gpt-5.5[high]");
    choices = chooseModel(choices, codex, "/notes/home", "gpt-5.5[low]");
    expect(modelFor(choices, codex, "/notes/work")).toBe("gpt-5.5[high]");
    expect(modelFor(choices, codex, "/notes/home")).toBe("gpt-5.5[low]");
    expect(modelFor(choices, codex, "/notes/other")).toBeNull();
  });

  test("means nothing to another agent, and is forgotten when the agent changes", () => {
    const codex = { kind: "codex" as const };
    const claude = { kind: "claudeCode" as const };
    let choices = chooseModel(NO_MODEL_CHOICES, codex, "/notes", "gpt-5.5[high]");
    expect(modelFor(choices, claude, "/notes")).toBeNull();

    choices = chooseModel(choices, claude, "/notes/b", "sonnet");
    expect(choices.byVault).toEqual({ "/notes/b": "sonnet" });
    expect(modelFor(choices, codex, "/notes")).toBeNull();
  });

  test("going back to the agent's own default forgets the choice", () => {
    const codex = { kind: "codex" as const };
    const choices = chooseModel(chooseModel(NO_MODEL_CHOICES, codex, "/n", "x"), codex, "/n", null);
    expect(modelFor(choices, codex, "/n")).toBeNull();
  });
});
