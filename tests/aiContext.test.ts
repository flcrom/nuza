import { describe, expect, test } from "bun:test";
import { buildContext, fileName, sectionsOf, selectionLines, type AiContext } from "../src/lib/ai/context";

function context(input: Parameters<typeof buildContext>[0]): AiContext {
  const built = buildContext(input);
  if (!built.ok) throw new Error(`expected a context, got ${built.reason}`);
  return built.context;
}

/** A long note: frontmatter, then `count` sections of `size` lines each. */
function longNote(count: number, size: number) {
  let text = "---\ntitle: Release\ntags: [work]\n---\n";
  for (let s = 1; s <= count; s++) {
    text += `## Section ${s}\n`;
    for (let l = 1; l <= size; l++) text += `Section ${s}, line ${l}: ${"lorem ipsum ".repeat(6)}\n`;
  }
  return text;
}

describe("what is sent about a note", () => {
  test("a short note is sent whole and is not marked as trimmed", () => {
    const text = "# Plan\n\nShip in March.\n";
    const built = context({ path: "/v/plan.md", text, selection: { from: 8, to: 22 }, wholeNote: true });
    expect(built.note).toBe(text);
    expect(built.trimmed).toBe(false);
    expect(built.omittedLines).toBe(0);
    expect(built.note.slice(built.selection!.from, built.selection!.to)).toBe("Ship in March.");
  });

  test("the path is never sent, only the filename", () => {
    const built = context({
      path: "/Users/me/vaults/acquisition-of-northwind/notes.md",
      text: "hello",
      selection: { from: 0, to: 0 },
      wholeNote: true,
    });
    expect(built.title).toBe("notes.md");
    expect(JSON.stringify(built)).not.toContain("acquisition-of-northwind");
    expect(fileName("C:\\Users\\me\\notes\\todo.md")).toBe("todo.md");
    expect(fileName("")).toBe("Untitled");
  });

  test("an empty caret is no selection", () => {
    const built = context({ path: "a.md", text: "hello", selection: { from: 2, to: 2 }, wholeNote: true });
    expect(built.selection).toBeNull();
  });

  test("with the whole note off, only the selection goes", () => {
    const text = "Private: the acquisition.\nHelp with this sentence please.\n";
    const from = text.indexOf("Help");
    const built = context({ path: "a.md", text, selection: { from, to: text.length - 1 }, wholeNote: false });
    expect(built.note).toBe("Help with this sentence please.");
    expect(built.selectionOnly).toBe(true);
    expect(built.note).not.toContain("acquisition");
    expect(built.selection).toEqual({ from: 0, to: built.note.length });

    const nothing = context({ path: "a.md", text, selection: { from: 3, to: 3 }, wholeNote: false });
    expect(nothing.note).toBe("");
  });
});

describe("a note past the budget", () => {
  const text = longNote(40, 30);
  const target = text.indexOf("Section 20, line 5:");
  const selection = { from: target, to: target + "Section 20, line 5:".length };
  const built = context({ path: "long.md", text, selection, wholeNote: true, budget: 20_000 });

  test("stays within the budget", () => {
    expect(text.length).toBeGreaterThan(20_000);
    expect(built.note.length).toBeLessThanOrEqual(20_000);
    expect(built.trimmed).toBe(true);
  });

  test("keeps the frontmatter, every heading, and the selection's section with its neighbours", () => {
    expect(built.note.startsWith("---\ntitle: Release\ntags: [work]\n---\n")).toBe(true);
    for (let s = 1; s <= 40; s++) expect(built.note).toContain(`## Section ${s}\n`);
    for (const s of [19, 20, 21]) expect(built.note).toContain(`Section ${s}, line 30:`);
  });

  test("the selection's offsets point into what is sent, not the original", () => {
    expect(built.note.slice(built.selection!.from, built.selection!.to)).toBe("Section 20, line 5:");
  });

  test("each gap says how many lines went, and they add up", () => {
    const gaps = [...built.note.matchAll(/\[… (\d+) lines? omitted …\]/g)].map((match) => Number(match[1]));
    expect(gaps.length).toBeGreaterThan(0);
    for (const lines of gaps) expect(lines).toBe(30);
    expect(gaps.reduce((a, b) => a + b, 0)).toBe(built.omittedLines);
  });

  test("fills outward from the selection, nearest sections first", () => {
    expect(built.note).toContain("Section 22, line 30:");
    expect(built.note).toContain("Section 18, line 30:");
    expect(built.note).not.toContain("Section 1, line 1:");
    expect(built.note).not.toContain("Section 40, line 1:");
  });

  test("with no selection, the caret's section is the one kept", () => {
    const caret = text.indexOf("Section 33, line 2:");
    const around = context({
      path: "long.md",
      text,
      selection: { from: caret, to: caret },
      wholeNote: true,
      budget: 20_000,
    });
    expect(around.selection).toBeNull();
    expect(around.note).toContain("Section 33, line 30:");
  });

  test("a selection bigger than the budget is too long to send", () => {
    expect(
      buildContext({
        path: "x.md",
        text,
        selection: { from: 0, to: text.length },
        wholeNote: true,
        budget: 20_000,
      })
    ).toEqual({
      ok: false,
      reason: "too-long",
    });
  });
});

describe("the sections of a note", () => {
  test("a # in a code block is not a heading", () => {
    const text = "# One\n```sh\n# not a heading\n```\n# Two\n";
    expect(sectionsOf(text).map((section) => section.heading)).toEqual(["# One\n", "# Two\n"]);
  });

  test("what comes before the first heading is a section of its own", () => {
    const text = "Intro\n# One\nBody\n";
    expect(sectionsOf(text).map((section) => text.slice(section.from, section.to))).toEqual([
      "Intro\n",
      "# One\nBody\n",
    ]);
  });
});

test("the selection chip counts lines from one", () => {
  const text = "a\nb\nc\nd\n";
  expect(selectionLines(text, { from: 2, to: 6 })).toEqual([2, 3]);
  expect(selectionLines(text, { from: 0, to: 1 })).toEqual([1, 1]);
});
