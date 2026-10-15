import type { Intent } from "./prompt";

/**
 * What the panel is mostly for: a handful of things writers ask for again
 * and again, one keystroke away - `/` in the composer, or a chip.
 *
 * Each is a request in plain words, sent as the writer's own would be. Those
 * that change the note come back as edits to review; those that explain come
 * back as an answer. Nothing here is hidden from the writer: the request is
 * what their message says it is.
 */

export type ActionId =
  "rephrase" | "synonym" | "explain-selection" | "explain-note" | "proofread" | "improve" | "remember";

export interface WritingAction {
  id: ActionId;
  /** What follows `/` to run it. */
  command: string;
  label: string;
  /** One line on what it does, for the menu. */
  hint: string;
  /**
   * What it works on: the selected text, a single word (the one at the caret
   * when nothing is selected), or whatever there is - the selection when
   * there is one, the note when there is not.
   */
  needs: "selection" | "word" | "anything";
  intent: Intent;
}

export const ACTIONS: WritingAction[] = [
  {
    id: "rephrase",
    command: "rephrase",
    label: "Rephrase",
    hint: "Say the selection another way, in your voice",
    needs: "selection",
    intent: "edit",
  },
  {
    id: "synonym",
    command: "synonym",
    label: "Synonym",
    hint: "Other words for the selected word",
    needs: "word",
    intent: "edit",
  },
  {
    id: "explain-selection",
    command: "explain",
    label: "Explain this",
    hint: "What the selection means, in the context of the note",
    needs: "selection",
    intent: "ask",
  },
  {
    id: "explain-note",
    command: "summary",
    label: "Explain the note",
    hint: "What this note is about, and how it is laid out",
    needs: "anything",
    intent: "ask",
  },
  {
    id: "proofread",
    command: "proofread",
    label: "Proofread",
    hint: "Spelling, grammar and punctuation, nothing else",
    needs: "anything",
    intent: "edit",
  },
  {
    id: "improve",
    command: "improve",
    label: "Improve writing",
    hint: "Clearer and tighter, in your voice",
    needs: "anything",
    intent: "edit",
  },
  {
    id: "remember",
    command: "remember",
    label: "Remember…",
    hint: "Something for the AI to keep in mind in this vault",
    needs: "anything",
    intent: "ask",
  },
];

export function actionById(id: ActionId): WritingAction {
  return ACTIONS.find((action) => action.id === id)!;
}

/** Whether an action can run with what is selected now. */
export function canRun(action: WritingAction, selected: boolean, onWord: boolean): boolean {
  if (action.needs === "selection") return selected;
  if (action.needs === "word") return selected || onWord;
  return true;
}

/** The actions a `/` command could mean, best match first. */
export function matchActions(query: string): WritingAction[] {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return ACTIONS;
  const starts = ACTIONS.filter(
    (action) => action.command.startsWith(wanted) || action.label.toLowerCase().startsWith(wanted)
  );
  const contains = ACTIONS.filter(
    (action) => !starts.includes(action) && action.label.toLowerCase().includes(wanted)
  );
  return [...starts, ...contains];
}

/** A `/command rest` typed in the composer, if that is what it is. */
export function parseCommand(text: string): { action: WritingAction; rest: string } | null {
  const match = /^\/(\S+)\s*([\s\S]*)$/.exec(text.trimStart());
  if (!match) return null;
  const action = ACTIONS.find((candidate) => candidate.command === match[1].toLowerCase());
  return action ? { action, rest: match[2].trim() } : null;
}

/**
 * What an action asks the agent, in the writer's own terms. `selected` says
 * whether there is a selection to work on; `extra` is anything the writer
 * typed after the command.
 */
export function requestFor(action: WritingAction, selected: boolean, extra: string): string {
  const what = selected ? "the selected text" : "this note";
  const base = {
    rephrase: "Rephrase the selected text so it reads better, keeping what it says and my voice.",
    synonym:
      "Suggest three to five words that could replace the selected word in this sentence, best first, each with a few words on how it differs. Put the best one in as an edit.",
    "explain-selection":
      "Explain the selected text in the context of the whole note: what it says, and how it fits with the rest.",
    "explain-note": "Explain this note: what it is about, its main points, and how it is laid out.",
    proofread: `Proofread ${what}: fix spelling, grammar and punctuation only, each as a small edit. Change nothing else, and say so if it is already clean.`,
    improve: `Improve the writing of ${what}: clearer and tighter, in my voice. Make the changes as edits, and say in a line what you changed.`,
    remember: "",
  }[action.id];
  // A change to the selection is to the selection alone.
  const inside =
    selected && action.intent === "edit"
      ? "\n\nChange only the selected text: every edit's `find` must be copied from inside the selection marks, even where the same words appear elsewhere in the note."
      : "";
  return extra ? `${base}${inside}\n\nAlso: ${extra}` : `${base}${inside}`;
}

/** The word at `position` in `text`, if the caret is in or against one. */
export function wordAt(text: string, position: number): { from: number; to: number } | null {
  const isWord = (char: string | undefined) => !!char && /[\p{L}\p{N}'’-]/u.test(char);
  let from = position;
  let to = position;
  while (from > 0 && isWord(text[from - 1])) from--;
  while (to < text.length && isWord(text[to])) to++;
  // Trim apostrophes and hyphens hanging off the ends.
  while (from < to && /['’-]/.test(text[from])) from++;
  while (to > from && /['’-]/.test(text[to - 1])) to--;
  return to > from ? { from, to } : null;
}
