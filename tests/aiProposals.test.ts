import { describe, expect, test } from "bun:test";
import {
  MAX_EDITS,
  MAX_FIND,
  afterRetry,
  againstLiveNote,
  hasEditsBlock,
  parseProposals,
  proseOf,
  retryRequest,
  newNotesIn,
  MAX_NEW_NOTES,
  editsIn,
} from "../src/lib/ai/proposals";
import { SELECTION_END, SELECTION_START } from "../src/lib/ai/prompt";

const note = "# Plan\n\nIt is probably the case that the release will slip.\n\n## Timeline\n\nTBD\n";

function block(edits: unknown, fence = "nuza-edits") {
  return "```" + fence + "\n" + JSON.stringify(edits, null, 2) + "\n```";
}

describe("reading proposed edits", () => {
  test("one edit is read, with where it goes in the note", () => {
    const answer = `Cut the hedging.\n\n${block([
      {
        find: "It is probably the case that the release will slip.",
        replace: "The release slips.",
        why: "Cut the hedging.",
      },
    ])}`;
    const parsed = parseProposals(answer, note);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const [edit] = parsed.proposals;
    expect(note.slice(edit.from, edit.to)).toBe("It is probably the case that the release will slip.");
    expect(edit.replace).toBe("The release slips.");
    expect(edit.why).toBe("Cut the hedging.");
  });

  test("several come back in the order they appear in the note", () => {
    const parsed = parseProposals(
      block([
        { find: "## Timeline\n\nTBD", replace: "## Timeline\n\nMarch.", why: "" },
        { find: "# Plan", replace: "# The plan", why: "" },
      ]),
      note
    );
    expect(parsed.ok && parsed.proposals.map((p) => p.find)).toEqual(["# Plan", "## Timeline\n\nTBD"]);
  });

  test("an anchor that appears twice is ambiguous, not applied to the first one", () => {
    const parsed = parseProposals(block([{ find: "the", replace: "a", why: "" }]), note);
    expect(parsed).toMatchObject({ ok: false, reason: "anchor-ambiguous", failed: [1] });
  });

  test("an anchor that is not there is missing, not silently skipped", () => {
    const parsed = parseProposals(
      block([
        { find: "# Plan", replace: "# The plan", why: "" },
        { find: "Beta in April", replace: "Beta in May", why: "" },
      ]),
      note
    );
    expect(parsed).toMatchObject({ ok: false, reason: "anchor-missing", failed: [2] });
    // The one that did line up is kept, for after the retry.
    expect(!parsed.ok && parsed.resolved?.map((p) => p.find)).toEqual(["# Plan"]);
  });

  test("overlapping edits are refused as a set", () => {
    const parsed = parseProposals(
      block([
        { find: "It is probably the case", replace: "Perhaps", why: "" },
        { find: "the case that the release", replace: "that the release", why: "" },
      ]),
      note
    );
    expect(parsed).toEqual({ ok: false, reason: "overlap" });
  });

  test("a trailing comma is forgiven; a block that is not JSON is not", () => {
    const comma = '```nuza-edits\n[{"find": "TBD", "replace": "March", "why": "",},]\n```';
    expect(parseProposals(comma, note).ok).toBe(true);
    const mangled = '```nuza-edits\n[{"find": "TBD" "replace": "March"}]\n```';
    expect(parseProposals(mangled, note)).toMatchObject({ ok: false, reason: "malformed" });
  });

  test("a fence with the wrong name is not an edits block", () => {
    expect(parseProposals(block([{ find: "TBD", replace: "March", why: "" }], "nuza-edit"), note)).toEqual({
      ok: false,
      reason: "no-block",
    });
  });

  test("prose with no block is not an error, just an answer", () => {
    expect(parseProposals("The release is in March.", note)).toEqual({ ok: false, reason: "no-block" });
    expect(hasEditsBlock("The release is in March.")).toBe(false);
  });

  test("a block described in prose before it is used still parses, from the last one", () => {
    const answer = [
      "I'll answer with a ```nuza-edits block, like this:",
      block([{ find: "nothing here", replace: "x", why: "" }]),
      "Here it is:",
      block([{ find: "TBD", replace: "March", why: "Filled in." }]),
    ].join("\n\n");
    const parsed = parseProposals(answer, note);
    expect(parsed.ok && parsed.proposals[0].replace).toBe("March");
  });

  test("a fence inside an edit's text does not cut the block short", () => {
    const code = "Run:\n\n```sh\nmake\n```\n";
    const answer = block([{ find: "TBD", replace: code, why: "" }]);
    const parsed = parseProposals(answer, note);
    expect(parsed.ok && parsed.proposals[0].replace).toBe(code);
  });

  test(`more than ${MAX_EDITS} edits are refused`, () => {
    const many = Array.from({ length: MAX_EDITS + 1 }, () => ({ find: "TBD", replace: "x", why: "" }));
    expect(parseProposals(block(many), note)).toMatchObject({ ok: false, reason: "too-many" });
  });

  test(`a find longer than ${MAX_FIND} characters is refused`, () => {
    const long = "x".repeat(MAX_FIND + 1);
    expect(parseProposals(block([{ find: long, replace: "", why: "" }]), note + long)).toMatchObject({
      ok: false,
      reason: "too-long",
    });
  });

  test("an empty find is refused: an insertion anchors on what it follows", () => {
    expect(parseProposals(block([{ find: "", replace: "x", why: "" }]), note)).toMatchObject({
      ok: false,
      reason: "malformed",
    });
  });

  test("the selection marks are taken back out of an anchor that copied them", () => {
    const answer = block([{ find: `${SELECTION_START}TBD${SELECTION_END}`, replace: "March", why: "" }]);
    const parsed = parseProposals(answer, note);
    expect(parsed.ok && parsed.proposals[0].find).toBe("TBD");
  });
});

describe("the answer around the edits", () => {
  test("the prose is shown and the block is left to the cards", () => {
    const answer = `Two changes.\n\n${block([{ find: "TBD", replace: "March", why: "" }])}`;
    expect(proseOf(answer)).toBe("Two changes.");
    expect(proseOf("No edits here.")).toBe("No edits here.");
  });

  test("a block still being written is known to be one", () => {
    expect(hasEditsBlock('Sure.\n\n```nuza-edits\n[{"find": "TB')).toBe(true);
    expect(proseOf('Sure.\n\n```nuza-edits\n[{"find": "TB')).toBe("Sure.");
  });
});

describe("the note as it is now", () => {
  test("an edit whose text was changed while the agent thought is set aside", () => {
    const parsed = parseProposals(
      block([
        { find: "# Plan", replace: "# The plan", why: "" },
        { find: "TBD", replace: "March", why: "" },
      ]),
      note
    );
    if (!parsed.ok) throw new Error("expected edits");
    const typed = note.replace("TBD", "Spring, probably").replace("# Plan", "Intro\n\n# Plan");
    const { fresh, stale } = againstLiveNote(parsed.proposals, typed);
    expect(stale.map((p) => p.find)).toEqual(["TBD"]);
    expect(typed.slice(fresh[0].from, fresh[0].to)).toBe("# Plan");
  });
});

test("the retry names the edits that failed, and only those", () => {
  expect(retryRequest([2])).toStartWith("Edit 2 could not be applied");
  expect(retryRequest([1, 3, 4])).toStartWith("Edits 1, 3 and 4 could not be applied");
  expect(retryRequest([2])).toContain("character-for-character");
});

describe("after the one retry", () => {
  const lined = () => {
    const parsed = parseProposals(
      block([
        { find: "# Plan", replace: "# The plan", why: "" },
        { find: "the", replace: "a", why: "" },
      ]),
      note
    );
    if (parsed.ok || !parsed.resolved) throw new Error("expected a partial result");
    return parsed.resolved;
  };

  test("the fixed edits join the ones that lined up the first time", () => {
    const retry = block([{ find: "that the release will slip", replace: "that it slips", why: "" }]);
    const { proposals, unplaced } = afterRetry(lined(), 1, retry, note);
    expect(proposals.map((p) => p.find)).toEqual(["# Plan", "that the release will slip"]);
    expect(unplaced).toBe(0);
  });

  test("a retry that still misses is counted, and what did line up is kept", () => {
    const { proposals, unplaced } = afterRetry(
      lined(),
      1,
      block([{ find: "the", replace: "a", why: "" }]),
      note
    );
    expect(proposals.map((p) => p.find)).toEqual(["# Plan"]);
    expect(unplaced).toBe(1);
  });

  test("a retry with no block at all leaves the first edits as they were", () => {
    expect(afterRetry(lined(), 1, "Sorry, I can't.", note)).toMatchObject({ unplaced: 1 });
  });
});

describe("a change asked for the selection alone", () => {
  // The word is in the note twice: in a paragraph, and on its own line,
  // selected.
  const note = "It cost me the charm I naturally had back then.\n\nnaturally\n";
  const selected = {
    from: note.lastIndexOf("naturally"),
    to: note.lastIndexOf("naturally") + "naturally".length,
  };
  const block = (edits: unknown) => "Options.\n\n```nuza-edits\n" + JSON.stringify(edits) + "\n```";

  test("the selected word is the one changed, however often it appears", () => {
    const parsed = parseProposals(
      block([{ find: "naturally", replace: "originally", why: "" }]),
      note,
      selected
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.proposals[0].from).toBe(selected.from);
  });

  test("an edit to the same word somewhere else is refused, and said to be", () => {
    const parsed = parseProposals(
      block([{ find: "the charm I naturally had", replace: "the charm I originally had", why: "" }]),
      note,
      selected
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.reason).toBe("outside-selection");
      expect(parsed.failed).toEqual([1]);
    }
  });

  test("without a selection to stay in, an anchor must still be unique", () => {
    const parsed = parseProposals(block([{ find: "naturally", replace: "originally", why: "" }]), note);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toBe("anchor-ambiguous");
  });

  test("in the note as it is now, it is found in the selection too", () => {
    const proposal = { id: "e", from: 0, to: 9, find: "naturally", replace: "originally", why: "" };
    const { fresh, stale } = againstLiveNote([proposal], note, selected);
    expect(stale).toEqual([]);
    expect(fresh[0].from).toBe(selected.from);
  });

  test("the retry says to stay inside the selection", () => {
    expect(retryRequest([1], true)).toContain("from inside the selection marks");
  });
});

describe("a new note the agent suggests", () => {
  const answer = (entries: unknown) => "Here it is.\n\n```nuza-edits\n" + JSON.stringify(entries) + "\n```";

  test("comes out of the same block as the edits, and the edits still parse", () => {
    const text = answer([
      { create: "ideas/launch.md", content: "# Launch\n\nSee [[release]].\n", why: "As asked." },
      { find: "Ship in March.", replace: "Ship in March. See [[launch]].", why: "Link it." },
    ]);
    expect(newNotesIn(text)).toEqual([
      { path: "ideas/launch.md", content: "# Launch\n\nSee [[release]].\n", why: "As asked." },
    ]);
    const parsed = parseProposals(text, "# Plan\n\nShip in March.\n");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.proposals).toHaveLength(1);
  });

  test("one that would land outside the folder is left out", () => {
    const notes = newNotesIn(
      answer([
        { create: "../outside.md", content: "x" },
        { create: "/etc/hosts", content: "x" },
        { create: "C:\\notes\\x.md", content: "x" },
        { create: "a//b.md", content: "x" },
        { create: "fine.md", content: "x" },
      ])
    );
    expect(notes.map((note) => note.path)).toEqual(["fine.md"]);
  });

  test("one without a path or content is left out, and only so many are taken", () => {
    expect(newNotesIn(answer([{ create: "x.md" }, { content: "y" }]))).toEqual([]);
    const many = Array.from({ length: MAX_NEW_NOTES + 3 }, (_, n) => ({ create: `n${n}.md`, content: "x" }));
    expect(newNotesIn(answer(many))).toHaveLength(MAX_NEW_NOTES);
  });

  test("an answer with only a new note has no edits to draw", () => {
    const read = editsIn(answer([{ create: "x.md", content: "# X" }]));
    expect(read.ok && read.edits).toEqual([]);
  });
});
