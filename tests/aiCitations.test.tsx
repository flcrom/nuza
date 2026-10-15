import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import AnswerText from "../src/components/AiPanel/AnswerText";
import { CitationContext } from "../src/components/AiPanel/citations";
import { forDisplay, parseCitation } from "../src/lib/ai/answerMarkdown";
import { stepTitle } from "../src/lib/ai/transcript";

describe("a citation in an answer", () => {
  test("names a note in the vault, and the paragraph when it gives one", () => {
    expect(parseCitation("nuza:projects/release.md#12")).toEqual({
      path: "projects/release.md",
      paragraph: 12,
    });
    expect(parseCitation("nuza:a%20b.md")).toEqual({ path: "a b.md", paragraph: null });
  });

  test("cannot climb out of the vault or name a path outright", () => {
    for (const href of [
      "nuza:../secret.md",
      "nuza:/etc/hosts",
      "nuza:a/../../b.md",
      "https://x.y",
      "nuza:",
    ]) {
      expect(parseCitation(href)).toBeNull();
    }
  });

  const answer = "As [the plan](nuza:projects/release.md#3) says, and [a guess](nuza:invented.md) does not.";
  const render = (citable: string[]) =>
    renderToStaticMarkup(
      <CitationContext.Provider value={{ citable: new Set(citable), open() {} }}>
        <AnswerText text={answer} />
      </CitationContext.Provider>
    );

  test("opens a note the agent was shown", () => {
    const markup = render(["projects/release.md"]);
    expect(markup).toMatch(/<button[^>]*title="projects\/release.md, paragraph 3"[^>]*>.*the plan<\/button>/);
  });

  test("is plain text when it names a note the agent was never shown", () => {
    const markup = render(["projects/release.md"]);
    expect(markup.match(/<button/g)).toHaveLength(1);
    expect(markup).toContain("<span>a guess</span>");
    // And with nothing shown, nothing links at all.
    expect(render([])).not.toContain("<button");
  });
});

describe("a step the agent takes", () => {
  test("a call to nuza's tools reads as what it did", () => {
    expect(stepTitle("mcp__nuza__search_vault")).toBe("Searched the vault");
    // OpenCode names them its own way.
    expect(stepTitle("nuza_search_vault")).toBe("Searched the vault");
    expect(stepTitle("nuza_read_note")).toBe(stepTitle("mcp__nuza__read_note"));
    expect(stepTitle("mcp.nuza.read_note")).toBe("Read a note");
    expect(stepTitle("Read releases.md")).toBe("Read releases.md");
    expect(stepTitle("mcp__nuza__write_note")).toBe("mcp__nuza__write_note");
  });
});

test("what the harness tells the agent is never shown either", () => {
  const recited =
    "You have tools from a server named `nuza` that read the writer's notes.\n(The note being asked about is `a.md` in the vault; `read_note` reads all of it.)\nThe answer.";
  expect(forDisplay(recited).trim()).toBe("The answer.");
});
