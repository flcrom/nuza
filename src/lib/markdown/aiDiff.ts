import { isolateHistory } from "@codemirror/commands";
import {
  EditorState,
  StateEffect,
  StateField,
  Transaction,
  type Extension,
  type Range,
  type TransactionSpec,
} from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";

/**
 * An agent's proposed edits, drawn over the note as a diff.
 *
 * Proposals are decorations over a document that has not changed: the text
 * a proposal would replace is struck through, what it would put there is
 * drawn beside it, and nothing in the note is different until a person
 * accepts. That is what makes rejecting free, and closing the panel half
 * way through reviewing safe.
 *
 * Accepting is an ordinary edit - one transaction, marked `input.ai` - so
 * undo, the unsaved dot, autosave and the changed-on-disk check all treat it
 * like any other. There is no second way to write a note.
 */

export interface PendingEdit {
  id: string;
  from: number;
  to: number;
  replace: string;
  why: string;
}

/** Puts these proposals over the note, in place of any it had. */
export const setProposals = StateEffect.define<PendingEdit[]>();
/** Takes one proposal away, accepted or not. */
export const resolveProposal = StateEffect.define<{ id: string; accept: boolean }>();
/** Marks one proposal as the one being looked at, from its card in the panel. */
export const focusProposal = StateEffect.define<string | null>();

/** Said on the window when a proposal leaves the note, so the panel's card can say how. */
export const PROPOSAL_EVENT = "nuza-ai-proposal";

export type ProposalOutcome = "accepted" | "rejected" | "dropped";

export interface ProposalEventDetail {
  id: string;
  outcome: ProposalOutcome;
}

interface Proposals {
  edits: PendingEdit[];
  focused: string | null;
}

/**
 * Whether a change takes away the text a proposal is about: it overlaps it,
 * or is typed into the middle of it. A change that only touches its edges
 * leaves it be.
 */
function touches(edit: PendingEdit, fromA: number, toA: number): boolean {
  if (fromA === toA) return fromA > edit.from && fromA < edit.to;
  return fromA < edit.to && toA > edit.from;
}

export const proposalField = StateField.define<Proposals>({
  create: () => ({ edits: [], focused: null }),
  update(value, transaction) {
    let { edits, focused } = value;
    if (transaction.docChanged) {
      edits = edits.flatMap((edit) => {
        let destroyed = false;
        transaction.changes.iterChangedRanges((fromA, toA) => {
          if (touches(edit, fromA, toA)) destroyed = true;
        });
        if (destroyed) return [];
        return [
          {
            ...edit,
            from: transaction.changes.mapPos(edit.from, 1),
            to: transaction.changes.mapPos(edit.to, -1),
          },
        ];
      });
    }
    for (const effect of transaction.effects) {
      if (effect.is(setProposals)) edits = [...effect.value].sort((a, b) => a.from - b.from);
      else if (effect.is(resolveProposal)) edits = edits.filter((edit) => edit.id !== effect.value.id);
      else if (effect.is(focusProposal)) focused = effect.value;
    }
    if (focused && !edits.some((edit) => edit.id === focused)) focused = null;
    return edits === value.edits && focused === value.focused ? value : { edits, focused };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => decorationsFor(value)),
});

/** The proposals waiting over a note. */
export function pendingEdits(state: EditorState): PendingEdit[] {
  return state.field(proposalField, false)?.edits ?? [];
}

/** The transaction that accepts one proposal: its change, as one undo step of its own. */
export function acceptSpec(state: EditorState, id: string): TransactionSpec | null {
  const edit = pendingEdits(state).find((pending) => pending.id === id);
  if (!edit) return null;
  return {
    changes: { from: edit.from, to: edit.to, insert: edit.replace },
    effects: resolveProposal.of({ id, accept: true }),
    annotations: [Transaction.userEvent.of("input.ai"), isolateHistory.of("full")],
    scrollIntoView: true,
  };
}

/**
 * The transaction that accepts every proposal at once: all the changes
 * together, so a single undo takes the whole set back.
 */
export function acceptAllSpec(state: EditorState): TransactionSpec | null {
  const edits = pendingEdits(state);
  if (!edits.length) return null;
  // Every position is in the document as it stands before any of them, and
  // CodeMirror applies the set as one; back to front is said only so that
  // the order is never a question.
  const ordered = [...edits].sort((a, b) => b.from - a.from);
  return {
    changes: ordered.map((edit) => ({ from: edit.from, to: edit.to, insert: edit.replace })),
    effects: ordered.map((edit) => resolveProposal.of({ id: edit.id, accept: true })),
    annotations: [Transaction.userEvent.of("input.ai"), isolateHistory.of("full")],
  };
}

export function acceptProposal(view: EditorView, id: string): boolean {
  const spec = acceptSpec(view.state, id);
  if (spec) view.dispatch(spec);
  return !!spec;
}

export function rejectProposal(view: EditorView, id: string) {
  view.dispatch({ effects: resolveProposal.of({ id, accept: false }) });
}

export function acceptAllProposals(view: EditorView): boolean {
  const spec = acceptAllSpec(view.state);
  if (spec) view.dispatch(spec);
  return !!spec;
}

export function rejectAllProposals(view: EditorView) {
  const edits = pendingEdits(view.state);
  if (edits.length)
    view.dispatch({ effects: edits.map((edit) => resolveProposal.of({ id: edit.id, accept: false })) });
}

class InsertionWidget extends WidgetType {
  constructor(
    readonly edit: PendingEdit,
    readonly block: boolean,
    readonly focused: boolean
  ) {
    super();
  }

  eq(other: InsertionWidget) {
    return (
      other.edit.id === this.edit.id &&
      other.edit.replace === this.edit.replace &&
      other.block === this.block &&
      other.focused === this.focused
    );
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement(this.block ? "div" : "span");
    wrap.className = `cm-ai-proposal${this.block ? " cm-ai-proposal-block" : ""}${this.focused ? " cm-ai-focused" : ""}`;
    wrap.dataset.proposal = this.edit.id;
    if (this.edit.replace) {
      const inserted = document.createElement("span");
      inserted.className = "cm-ai-insert";
      // Text, never markup: this came from the model.
      inserted.textContent = this.edit.replace;
      wrap.append(inserted);
    }
    const actions = document.createElement("span");
    actions.className = "cm-ai-actions";
    const button = (label: string, title: string, act: () => void) => {
      const element = document.createElement("button");
      element.type = "button";
      element.textContent = label;
      element.title = title;
      // On the press, before the editor takes the click as a place to put the caret.
      element.addEventListener("mousedown", (event) => {
        event.preventDefault();
        act();
      });
      return element;
    };
    actions.append(
      button("Accept", this.edit.why || "Make this change", () => acceptProposal(view, this.edit.id)),
      button("Reject", "Leave the note as it is", () => rejectProposal(view, this.edit.id))
    );
    wrap.append(actions);
    return wrap;
  }

  ignoreEvent() {
    return true;
  }
}

function decorationsFor({ edits, focused }: Proposals): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const edit of edits) {
    const isFocused = edit.id === focused;
    if (edit.to > edit.from) {
      ranges.push(
        Decoration.mark({
          class: `cm-ai-delete${isFocused ? " cm-ai-focused" : ""}`,
          attributes: { "data-proposal": edit.id },
        }).range(edit.from, edit.to)
      );
    }
    // A replacement of more than a line is drawn as a block of its own; a
    // word or two stays in the line, so a small change does not reflow the
    // paragraph around it.
    const block = edit.replace.includes("\n");
    ranges.push(
      Decoration.widget({ widget: new InsertionWidget(edit, block, isFocused), side: 1, block: false }).range(
        edit.to
      )
    );
  }
  return Decoration.set(ranges, true);
}

/** Tells the panel when a proposal has left the note, and why. */
const announce = EditorView.updateListener.of((update) => {
  const before = update.startState.field(proposalField, false)?.edits ?? [];
  if (!before.length) return;
  const after = new Set(update.state.field(proposalField, false)?.edits.map((edit) => edit.id) ?? []);
  const decided = new Map<string, boolean>();
  for (const transaction of update.transactions) {
    for (const effect of transaction.effects) {
      if (effect.is(resolveProposal)) decided.set(effect.value.id, effect.value.accept);
    }
  }
  for (const edit of before) {
    if (after.has(edit.id)) continue;
    const accepted = decided.get(edit.id);
    const outcome: ProposalOutcome = accepted === undefined ? "dropped" : accepted ? "accepted" : "rejected";
    window.dispatchEvent(
      new CustomEvent<ProposalEventDetail>(PROPOSAL_EVENT, { detail: { id: edit.id, outcome } })
    );
  }
});

// Struck through, and drawn in, so the change reads without its colours -
// which are faint enough to hold up in light, dark and any accent.
const theme = EditorView.baseTheme({
  ".cm-ai-delete": {
    textDecoration: "line-through",
    textDecorationColor: "rgba(239, 68, 68, 0.75)",
    backgroundColor: "rgba(239, 68, 68, 0.1)",
  },
  ".cm-ai-proposal": {
    whiteSpace: "pre-wrap",
  },
  ".cm-ai-proposal-block": {
    display: "block",
    margin: "4px 0",
  },
  ".cm-ai-insert": {
    backgroundColor: "rgba(34, 197, 94, 0.12)",
    borderLeft: "2px solid rgba(34, 197, 94, 0.75)",
    padding: "0 2px",
  },
  ".cm-ai-proposal-block .cm-ai-insert": {
    display: "block",
    padding: "2px 8px",
  },
  ".cm-ai-actions": {
    display: "inline-flex",
    gap: "4px",
    marginLeft: "6px",
    verticalAlign: "middle",
    fontFamily: "Inter Variable, system-ui, sans-serif",
    fontSize: "11px",
    lineHeight: "1",
  },
  ".cm-ai-actions button": {
    cursor: "pointer",
    border: "1px solid var(--nuza-hairline)",
    borderRadius: "4px",
    padding: "2px 6px",
    background: "var(--nuza-surface)",
    color: "var(--nuza-fg)",
  },
  ".cm-ai-actions button:hover": {
    borderColor: "var(--nuza-accent)",
  },
  ".cm-ai-focused": {
    outline: "1px solid var(--nuza-accent)",
    outlineOffset: "1px",
    borderRadius: "2px",
  },
});

export const aiDiff: Extension = [proposalField, announce, theme];
