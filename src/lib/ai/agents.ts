import type { AgentConfig, Detection, Found, PresetId } from "./protocol";

/**
 * The agents nuza knows how to start, as Settings shows them.
 *
 * What actually runs is decided in Rust (`src-tauri/src/agent/config.rs`),
 * from a table the webview cannot change: picking one here sends only which
 * one. The adapter pins below are the ones that table runs, shown so a person
 * can see exactly what will be fetched - and a Rust test fails if the two
 * ever disagree.
 */
export const CLAUDE_ADAPTER = "@agentclientprotocol/claude-agent-acp@0.90.0";
export const CODEX_ADAPTER = "@agentclientprotocol/codex-acp@2.2.2";

export const AI_DOCS_URL = "https://www.nuza.org/docs/ai";

export interface Preset {
  id: PresetId;
  config: AgentConfig;
  label: string;
  /** Whose plan it runs on, in a line. */
  blurb: string;
  /** What else it needs, beyond the agent itself. */
  needs?: string;
  /** How to get it, when it is not found. */
  install: string;
  /** How to sign in, once it is there. */
  signIn: string;
  /** What nuza runs, shown so nothing about it is hidden. */
  runs: string;
  /** Whether it is started through `npx`, and so needs Node. */
  needsNode: boolean;
}

export const PRESETS: Preset[] = [
  {
    id: "claude-code",
    config: { kind: "claudeCode" },
    label: "Claude Code",
    blurb: "Your local Claude Code, on your own Claude plan.",
    needs: "Needs Node.js 22 or newer.",
    install: "npm install -g @anthropic-ai/claude-code",
    signIn: "Run `claude` once in a terminal and sign in.",
    runs: `npx ${CLAUDE_ADAPTER}`,
    needsNode: true,
  },
  {
    id: "codex",
    config: { kind: "codex" },
    label: "Codex",
    blurb: "Your local Codex, on your own ChatGPT plan.",
    needs: "Needs Node.js 22 or newer.",
    install: "npm install -g @openai/codex",
    signIn: "Run `codex login`.",
    runs: `npx ${CODEX_ADAPTER}`,
    needsNode: true,
  },
  {
    id: "opencode",
    config: { kind: "openCode" },
    label: "OpenCode",
    blurb: "Your local OpenCode, on whichever provider you set it up with.",
    install: "curl -fsSL https://opencode.ai/install | bash",
    signIn: "Run `opencode auth login`.",
    runs: "opencode acp",
    needsNode: false,
  },
];

/**
 * What to say while an agent starts. One reached through `npx` downloads
 * its adapter the first time, which can take minutes on an ordinary
 * connection, and a "Starting…" that sits there that long reads as broken.
 */
export function startingNote(config: AgentConfig | null): string | null {
  const preset = presetFor(config);
  if (!preset) return null;
  return preset.needsNode
    ? `Starting ${preset.label}. The first time, this downloads its connector, which can take a few minutes.`
    : `Starting ${preset.label}…`;
}

/** The preset an agent config is, if it is one. */
export function presetFor(config: AgentConfig | null): Preset | undefined {
  return config ? PRESETS.find((preset) => preset.config.kind === config.kind) : undefined;
}

/** What detection found for a preset. */
export function foundFor(detection: Detection | null, id: PresetId): Found | undefined {
  return detection?.agents.find((found) => found.id === id);
}

export type Readiness =
  /** Detection has not run yet. */
  | { state: "unknown" }
  /** The agent's program is there, and so is anything it needs. */
  | { state: "found"; path: string; version: string | null; signedIn: boolean | null }
  /** The agent is there but Node, which its adapter runs on, is not. */
  | { state: "needs-node"; path: string }
  | { state: "missing" };

/** Whether a preset can be used on this computer, as far as nuza can tell. */
export function readiness(preset: Preset, detection: Detection | null): Readiness {
  if (!detection) return { state: "unknown" };
  const found = foundFor(detection, preset.id);
  if (!found?.path) return { state: "missing" };
  if (preset.needsNode && !detection.node) return { state: "needs-node", path: found.path };
  return { state: "found", path: found.path, version: found.version, signedIn: found.signedIn };
}

/** Whether two configs are the same agent. */
export function sameAgent(a: AgentConfig | null, b: AgentConfig | null): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === "custom" && b.kind === "custom") {
    return (
      a.command.trim() === b.command.trim() &&
      a.args.join("\u0000") === b.args.join("\u0000") &&
      a.dataDirs.join("\u0000") === b.dataDirs.join("\u0000")
    );
  }
  return true;
}

/** Splits an argument line the way a person types it, keeping quoted parts whole. */
export function splitArgs(line: string): string[] {
  const args: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const match of line.matchAll(pattern)) args.push(match[1] ?? match[2] ?? match[3]);
  return args;
}

/** One folder per line or comma, with the blanks left out. */
export function splitDirs(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((dir) => dir.trim())
    .filter(Boolean);
}
