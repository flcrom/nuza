import { describe, expect, test } from "bun:test";
import { forDisplay, isWebLink, parseAnswer, parseInline } from "../src/lib/ai/answerMarkdown";
import { FRAMING_PHRASES, buildFollowUp, buildPrompt } from "../src/lib/ai/prompt";

describe("an answer's Markdown", () => {
  test("paragraphs, headings, lists and code come out as blocks", () => {
    const blocks = parseAnswer(
      "## Summary\n\nTwo things:\n\n- first\n- second\n\n```ts\nconst a = 1;\n```\n\n1. one\n2. two"
    );
    expect(blocks.map((block) => block.type)).toEqual(["heading", "paragraph", "list", "code", "list"]);
    expect(blocks[2]).toMatchObject({ ordered: false, items: [[{ text: "first" }], [{ text: "second" }]] });
    expect(blocks[3]).toEqual({ type: "code", language: "ts", text: "const a = 1;" });
    expect(blocks[4]).toMatchObject({ ordered: true });
  });

  test("emphasis, code and links inside a line", () => {
    expect(parseInline("a **bold** and *soft* `x` [docs](https://example.com)")).toEqual([
      { type: "text", text: "a " },
      { type: "strong", children: [{ type: "text", text: "bold" }] },
      { type: "text", text: " and " },
      { type: "em", children: [{ type: "text", text: "soft" }] },
      { type: "text", text: " " },
      { type: "code", text: "x" },
      { type: "text", text: " " },
      { type: "link", href: "https://example.com", children: [{ type: "text", text: "docs" }] },
    ]);
  });

  test("markup that looks like HTML stays text", () => {
    const blocks = parseAnswer('<img src=x onerror="alert(1)"> <script>bad()</script>');
    expect(blocks).toEqual([
      {
        type: "paragraph",
        children: [{ type: "text", text: '<img src=x onerror="alert(1)"> <script>bad()</script>' }],
      },
    ]);
  });

  test("only web addresses are links anyone can open", () => {
    expect(isWebLink("https://example.com")).toBe(true);
    expect(isWebLink("http://example.com")).toBe(true);
    for (const href of ["javascript:alert(1)", "file:///etc/hosts", "nuza-media://x", "data:text/html,hi"]) {
      expect(isWebLink(href)).toBe(false);
    }
  });

  test("an unclosed code block runs to the end rather than being lost", () => {
    expect(parseAnswer("```\nstill streaming")).toEqual([
      { type: "code", language: "", text: "still streaming" },
    ]);
  });

  test("a lone asterisk is not emphasis", () => {
    expect(parseInline("2 * 3 = 6")).toEqual([{ type: "text", text: "2 * 3 = 6" }]);
  });
});

describe("an answer as it is shown", () => {
  test("never shows nuza's framing, even when the agent recites it", () => {
    const framing = buildPrompt(
      {
        agent: "Claude Code",
        question: "hello there",
        context: {
          title: "plan.md",
          note: "Ship in March.",
          selection: { from: 0, to: 4 },
          trimmed: true,
          omittedLines: 3,
          selectionOnly: false,
        },
        intent: "ask",
        declined: [{ find: "a", replace: "b" }],
      },
      "e72bcccb7ec"
    );
    const shown = forDisplay(`You said: ${framing}`);
    for (const phrase of FRAMING_PHRASES) expect(shown).not.toContain(phrase);
    expect(shown).not.toContain("e72bcccb7ec");
    expect(shown).not.toContain("⟦");
    // The writer's own words survive.
    expect(shown).toContain("Ship in March.");
    expect(shown).toContain("hello there");
  });

  test("every phrase it looks for is one the framing really uses", () => {
    const full = [
      buildPrompt(
        {
          agent: "Codex",
          question: "?",
          context: {
            title: "a.md",
            note: "x",
            selection: { from: 0, to: 1 },
            trimmed: true,
            omittedLines: 1,
            selectionOnly: false,
          },
          intent: "ask",
          declined: [{ find: "a", replace: "b" }],
          instructions: "Be brief.",
          memory: ["British spelling"],
          history: [{ question: "Earlier?", answer: "Yes." }],
        },
        "n0"
      ),
      buildPrompt({
        agent: "Codex",
        question: "?",
        context: {
          title: "a.md",
          note: "x",
          selection: null,
          trimmed: true,
          omittedLines: 0,
          selectionOnly: true,
        },
        intent: "edit",
      }),
      buildFollowUp({ agent: "Codex", question: "?", context: null, intent: "ask" }),
    ].join("\n");
    for (const phrase of FRAMING_PHRASES) expect(full).toContain(phrase);
  });

  test("an ordinary answer is left as it is", () => {
    const answer = "The release slips to **March**.\n\n- Beta first\n- Then GA";
    expect(forDisplay(answer)).toBe(answer);
  });
});
