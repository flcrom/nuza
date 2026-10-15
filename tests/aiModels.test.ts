import { describe, expect, test } from "bun:test";
import { NO_MODEL_CHOICES, cheapestModel, chooseModel, modelToUse } from "../src/lib/ai/modelChoice";
import type { ModelInfo } from "../src/lib/ai/protocol";

const offered = (...ids: [string, string][]): ModelInfo[] =>
  ids.map(([id, name]) => ({ id, name, description: "" }));

// As the real agents list them.
const claude = offered(
  ["default", "Default (recommended)"],
  ["opus", "Opus 5.5"],
  ["sonnet", "Sonnet 5.5"],
  ["fable", "Fable 5.1"],
  ["haiku", "Haiku 5.5"],
  ["claude-haiku-4-5-20251001", "Haiku 4.5"]
);
const opencode = offered(
  // Listed first, and "free" - but a Go model, which needs a Go subscription.
  ["opencode-go/cat-jam-free", "OpenCode Go/Cat Jam Free"],
  ["opencode-go/deepseek-v4-pro", "OpenCode Go/DeepSeek V4 Pro (New)"],
  ["opencode-go/glm-5.3-flash", "OpenCode Go/GLM-5.3-Flash"],
  ["opencode/big-pickle", "OpenCode/Big Pickle"],
  ["opencode/nemotron-3.5-lightning-free", "OpenCode/Nemotron 3.5 Lightning Free"]
);
const codex = offered(
  ["gpt-5.5[high]", "gpt-5.5 (high)"],
  ["gpt-5.5[low]", "gpt-5.5 (low)"],
  ["gpt-5.5-mini[medium]", "gpt-5.5-mini (medium)"],
  ["gpt-5.5-mini[low]", "gpt-5.5-mini (low)"]
);

describe("the cheapest model", () => {
  test("for Claude Code is the newest Haiku, never the default entry", () => {
    expect(cheapestModel(claude)).toBe("haiku");
  });

  test("for OpenCode is a free one that needs no subscription", () => {
    expect(cheapestModel(opencode)).toBe("opencode/big-pickle");
  });

  test("for Codex is the small model at the least effort", () => {
    expect(cheapestModel(codex)).toBe("gpt-5.5-mini[low]");
  });

  test("with nothing offered there is none, and the agent picks", () => {
    expect(cheapestModel([])).toBeNull();
  });
});

describe("the model a question is answered with", () => {
  const agent = { kind: "claudeCode" } as const;

  test("is the cheapest until the writer picks one", () => {
    expect(modelToUse(NO_MODEL_CHOICES, agent, "/notes", claude)).toBe("haiku");
    const picked = chooseModel(NO_MODEL_CHOICES, agent, "/notes", "opus");
    expect(modelToUse(picked, agent, "/notes", claude)).toBe("opus");
  });

  test("goes back to the cheapest when the one picked is no longer offered", () => {
    const picked = chooseModel(NO_MODEL_CHOICES, agent, "/notes", "claude-opus-4-1");
    expect(modelToUse(picked, agent, "/notes", claude)).toBe("haiku");
  });
});
