import type { AgentErrorKind, AgentEvent, PlanEntry } from "./protocol";

/**
 * One answer from the agent, built up from the events of its turn.
 *
 * Kept as parts in the order they happened - a step between two runs of
 * words stays between them - because "it searched, then it said" is part of
 * what the answer is.
 */
export type AnswerPart =
  | { type: "text"; text: string }
  | { type: "thought"; text: string }
  | { type: "step"; id: string; title: string; status: string }
  /** What nuza did not let the agent do. */
  | { type: "refused"; action: string }
  | { type: "notice"; text: string };

export interface Answer {
  parts: AnswerPart[];
  plan: PlanEntry[];
  usage: { used: number; size: number } | null;
  state: "streaming" | "done" | "failed";
  /** The agent's reason for stopping: `end_turn`, `cancelled`, `refusal`… */
  stopReason: string | null;
  error: { code: AgentErrorKind; message: string } | null;
}

export function emptyAnswer(): Answer {
  return { parts: [], plan: [], usage: null, state: "streaming", stopReason: null, error: null };
}

/** `answer`, with `event` taken in. Never changes `answer` itself. */
export function applyEvent(answer: Answer, event: AgentEvent): Answer {
  const parts = answer.parts;
  const last = parts[parts.length - 1];
  switch (event.kind) {
    case "token":
      return last?.type === "text"
        ? { ...answer, parts: [...parts.slice(0, -1), { type: "text", text: last.text + event.text }] }
        : { ...answer, parts: [...parts, { type: "text", text: event.text }] };
    case "thought":
      return last?.type === "thought"
        ? { ...answer, parts: [...parts.slice(0, -1), { type: "thought", text: last.text + event.text }] }
        : { ...answer, parts: [...parts, { type: "thought", text: event.text }] };
    case "step": {
      // An update only carries what changed, and is merged into the step it
      // updates wherever that is.
      const at = parts.findIndex((part) => part.type === "step" && part.id === event.id);
      if (at === -1) {
        const step: AnswerPart = {
          type: "step",
          id: event.id,
          title: event.title ?? "Working",
          status: event.status ?? "pending",
        };
        return { ...answer, parts: [...parts, step] };
      }
      const known = parts[at] as Extract<AnswerPart, { type: "step" }>;
      const merged: AnswerPart = {
        ...known,
        title: event.title ?? known.title,
        status: event.status ?? known.status,
      };
      return { ...answer, parts: parts.map((part, index) => (index === at ? merged : part)) };
    }
    case "plan":
      return { ...answer, plan: event.entries };
    case "usage":
      return { ...answer, usage: { used: event.used, size: event.size } };
    case "refused":
      return { ...answer, parts: [...parts, { type: "refused", action: event.action }] };
    case "notice":
      return { ...answer, parts: [...parts, { type: "notice", text: event.text }] };
    case "done":
      return { ...answer, state: "done", stopReason: event.stop_reason };
    case "failed":
      return { ...answer, state: "failed", error: { code: event.code, message: event.message } };
  }
}

const TOOL_STEPS: Record<string, string> = {
  search_vault: "Searched the vault",
  read_note: "Read a note",
  list_notes: "Looked through the notes",
  outline: "Read a note's headings",
  backlinks: "Found what links to a note",
  list_tags: "Looked at the tags",
  notes_with_tag: "Found notes with a tag",
};

/** A step's title in words: a call to one of nuza's tools reads as what it did. */
export function stepTitle(title: string): string {
  // `mcp__nuza__search_vault` from Claude Code, `nuza_search_vault` from OpenCode.
  const tool = /^(?:mcp(?:__|\.))?nuza(?:__|\.|_)(\w+)$/.exec(title.trim())?.[1];
  return (tool && TOOL_STEPS[tool]) || title;
}

/** The words of an answer, without its thoughts, steps or notes. */
export function answerText(answer: Answer): string {
  return answer.parts
    .filter((part): part is Extract<AnswerPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

/** How much of the model's context window is in use, as a whole percentage. */
export function contextUsed(answer: Answer): number | null {
  if (!answer.usage || answer.usage.size <= 0) return null;
  return Math.min(100, Math.round((answer.usage.used / answer.usage.size) * 100));
}
