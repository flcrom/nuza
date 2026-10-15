import { beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
  ACTIONS,
  actionById,
  canRun,
  matchActions,
  parseCommand,
  requestFor,
  wordAt,
} from "../src/lib/ai/actions";
import {
  KEPT_TURNS,
  MEMORY_ITEMS,
  NO_MEMORY,
  forget,
  loadConversation,
  memoryFor,
  remember,
  saveConversation,
  type SavedTurn,
} from "../src/lib/ai/memory";

describe("writing actions", () => {
  test("cover what writers ask for most", () => {
    expect(ACTIONS.map((action) => action.id)).toEqual([
      "rephrase",
      "synonym",
      "explain-selection",
      "explain-note",
      "proofread",
      "improve",
      "remember",
    ]);
  });

  test("those that change the note come back as edits; those that explain, as answers", () => {
    for (const id of ["rephrase", "synonym", "proofread", "improve"] as const)
      expect(actionById(id).intent).toBe("edit");
    for (const id of ["explain-selection", "explain-note"] as const)
      expect(actionById(id).intent).toBe("ask");
  });

  test("an action on the selection waits for one; a synonym can use the word at the caret", () => {
    expect(canRun(actionById("rephrase"), false, true)).toBe(false);
    expect(canRun(actionById("rephrase"), true, false)).toBe(true);
    expect(canRun(actionById("synonym"), false, true)).toBe(true);
    expect(canRun(actionById("synonym"), false, false)).toBe(false);
    expect(canRun(actionById("proofread"), false, false)).toBe(true);
  });

  test("proofreading and improving work on the selection, or else the whole note", () => {
    expect(requestFor(actionById("proofread"), true, "")).toContain("Proofread the selected text");
    expect(requestFor(actionById("proofread"), false, "")).toContain("Proofread this note");
    expect(requestFor(actionById("improve"), false, "")).toContain("Improve the writing of this note");
  });

  test("anything typed after the command goes along with it", () => {
    expect(requestFor(actionById("improve"), true, "make it friendlier")).toMatch(
      /\n\nAlso: make it friendlier$/
    );
  });

  test("a / command is recognised, with what follows it", () => {
    expect(parseCommand("/rephrase shorter please")).toEqual({
      action: actionById("rephrase"),
      rest: "shorter please",
    });
    expect(parseCommand("  /PROOFREAD")).toEqual({ action: actionById("proofread"), rest: "" });
    expect(parseCommand("/nonsense")).toBeNull();
    expect(parseCommand("what does /rephrase do")).toBeNull();
  });

  test("the menu narrows as the command is typed", () => {
    expect(matchActions("").length).toBe(ACTIONS.length);
    expect(matchActions("pro").map((action) => action.id)).toEqual(["proofread", "improve"]);
    expect(matchActions("ex").map((action) => action.id)).toEqual(["explain-selection", "explain-note"]);
    expect(matchActions("writ").map((action) => action.id)).toEqual(["improve"]);
  });

  test("the word at the caret is found, apostrophes and all", () => {
    const text = "It's a well-known plan, isn't it?";
    expect(text.slice(...Object.values(wordAt(text, 9)!))).toBe("well-known");
    expect(text.slice(...Object.values(wordAt(text, 2)!))).toBe("It's");
    expect(text.slice(...Object.values(wordAt(text, 22)!))).toBe("plan");
    expect(wordAt("  ", 1)).toBeNull();
  });
});

describe("what the AI remembers", () => {
  test("is kept per vault, without repeats or blanks", () => {
    let store = remember(NO_MEMORY, "/notes/work", "I write in British English");
    store = remember(store, "/notes/work", "  i write in british english ");
    store = remember(store, "/notes/work", "   ");
    store = remember(store, "/notes/home", "Call me Sam");
    expect(memoryFor(store, "/notes/work")).toEqual(["I write in British English"]);
    expect(memoryFor(store, "/notes/home")).toEqual(["Call me Sam"]);
    expect(memoryFor(store, "/elsewhere")).toEqual([]);
  });

  test("keeps the newest when it is full, and lets things be forgotten", () => {
    let store = NO_MEMORY;
    for (let n = 0; n <= MEMORY_ITEMS; n++) store = remember(store, null, `thing ${n}`);
    expect(memoryFor(store, null)).toHaveLength(MEMORY_ITEMS);
    expect(memoryFor(store, null)[0]).toBe("thing 1");
    store = forget(store, null, 0);
    expect(memoryFor(store, null)[0]).toBe("thing 2");
  });
});

describe("the conversation, kept", () => {
  beforeEach(() => {
    const window = new Window();
    globalThis.localStorage = window.localStorage as unknown as Storage;
  });

  const turn = (n: number): SavedTurn => ({
    request: `Q${n}`,
    text: `Q${n}`,
    action: null,
    about: null,
    answer: `A${n}`,
    failed: null,
    took: 1000,
  });

  test("comes back for the same vault, and not for another", () => {
    saveConversation("/notes/work", [turn(1), turn(2)]);
    expect(loadConversation("/notes/work").map((t) => t.answer)).toEqual(["A1", "A2"]);
    expect(loadConversation("/notes/home")).toEqual([]);
  });

  test("keeps only the latest turns, and clearing it leaves nothing", () => {
    saveConversation(
      null,
      Array.from({ length: KEPT_TURNS + 5 }, (_, n) => turn(n))
    );
    expect(loadConversation(null)).toHaveLength(KEPT_TURNS);
    expect(loadConversation(null)[0].request).toBe("Q5");
    saveConversation(null, []);
    expect(loadConversation(null)).toEqual([]);
  });

  test("something in storage that is not a conversation is no conversation", () => {
    localStorage.setItem("nuza:ai-chat:", "{nonsense");
    expect(loadConversation(null)).toEqual([]);
  });
});
