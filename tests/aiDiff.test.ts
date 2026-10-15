import { describe, expect, test } from "bun:test";
import { history, undo } from "@codemirror/commands";
import { EditorState, type TransactionSpec } from "@codemirror/state";
import {
  acceptAllSpec,
  acceptSpec,
  aiDiff,
  pendingEdits,
  resolveProposal,
  setProposals,
  type PendingEdit,
} from "../src/lib/markdown/aiDiff";

const note = "# Plan\n\nIt is probably the case that the release will slip.\n\nTBD\n";

function edit(id: string, find: string, replace: string): PendingEdit {
  const from = note.indexOf(find);
  return { id, from, to: from + find.length, replace, why: "" };
}

/** A note with these proposals over it, and undo history, as the editor has it. */
function withProposals(...edits: PendingEdit[]) {
  let state = EditorState.create({ doc: note, extensions: [history(), aiDiff] });
  const apply = (spec: TransactionSpec) => {
    state = state.update(spec).state;
  };
  apply({ effects: setProposals.of(edits) });
  return {
    get state() {
      return state;
    },
    apply,
    undo() {
      undo({ state, dispatch: (transaction) => (state = transaction.state) });
    },
  };
}

describe("proposals over a note", () => {
  test("change nothing until they are accepted", () => {
    const editor = withProposals(edit("a", "TBD", "March"));
    expect(editor.state.doc.toString()).toBe(note);
    expect(pendingEdits(editor.state)).toHaveLength(1);
  });

  test("follow an insertion earlier in the note", () => {
    const editor = withProposals(edit("a", "TBD", "March"));
    editor.apply({ changes: { from: 0, insert: "Intro\n\n" } });
    const [moved] = pendingEdits(editor.state);
    expect(editor.state.sliceDoc(moved.from, moved.to)).toBe("TBD");
  });

  test("survive typing right up against them", () => {
    const editor = withProposals(edit("a", "TBD", "March"));
    const { from, to } = pendingEdits(editor.state)[0];
    editor.apply({
      changes: [
        { from, insert: "(" },
        { from: to, insert: ")" },
      ],
    });
    const [kept] = pendingEdits(editor.state);
    expect(editor.state.sliceDoc(kept.from, kept.to)).toBe("TBD");
  });

  test("are dropped when their text is deleted or typed into", () => {
    const deleted = withProposals(edit("a", "TBD", "March"));
    const at = note.indexOf("TBD");
    deleted.apply({ changes: { from: at, to: at + 3 } });
    expect(pendingEdits(deleted.state)).toEqual([]);

    const typedInto = withProposals(edit("a", "TBD", "March"));
    typedInto.apply({ changes: { from: at + 1, insert: "x" } });
    expect(pendingEdits(typedInto.state)).toEqual([]);
  });
});

describe("accepting", () => {
  test("is one transaction, and one undo puts the text back exactly", () => {
    const editor = withProposals(
      edit("a", "It is probably the case that the release will slip.", "The release slips.")
    );
    editor.apply(acceptSpec(editor.state, "a")!);
    expect(editor.state.doc.toString()).toBe(
      note.replace("It is probably the case that the release will slip.", "The release slips.")
    );
    expect(pendingEdits(editor.state)).toEqual([]);

    editor.undo();
    expect(editor.state.doc.toString()).toBe(note);
  });

  test("two accepts in quick succession are two undo steps, not one", () => {
    const editor = withProposals(edit("a", "# Plan", "# The plan"), edit("b", "TBD", "March"));
    editor.apply(acceptSpec(editor.state, "a")!);
    editor.apply(acceptSpec(editor.state, "b")!);
    editor.undo();
    expect(editor.state.doc.toString()).toBe(note.replace("# Plan", "# The plan"));
  });

  test("accepting all is one transaction that leaves the note right, and one undo takes it all back", () => {
    const editor = withProposals(
      edit("a", "# Plan", "# The plan"),
      edit("b", "It is probably the case that the release will slip.", "The release slips."),
      edit("c", "TBD", "Beta in March,\nGA in May.")
    );
    editor.apply(acceptAllSpec(editor.state)!);
    expect(editor.state.doc.toString()).toBe(
      "# The plan\n\nThe release slips.\n\nBeta in March,\nGA in May.\n"
    );
    expect(pendingEdits(editor.state)).toEqual([]);

    editor.undo();
    expect(editor.state.doc.toString()).toBe(note);
  });

  test("a proposal that has gone cannot be accepted", () => {
    const editor = withProposals(edit("a", "TBD", "March"));
    editor.apply({ effects: resolveProposal.of({ id: "a", accept: false }) });
    expect(acceptSpec(editor.state, "a")).toBeNull();
    expect(acceptAllSpec(editor.state)).toBeNull();
  });
});

test("rejecting changes no text", () => {
  const editor = withProposals(edit("a", "TBD", "March"), edit("b", "# Plan", "# The plan"));
  editor.apply({ effects: resolveProposal.of({ id: "a", accept: false }) });
  expect(editor.state.doc.toString()).toBe(note);
  expect(pendingEdits(editor.state).map((pending) => pending.id)).toEqual(["b"]);
});
