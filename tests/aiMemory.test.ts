import { beforeEach, describe, expect, test } from "bun:test";
import {
  KEPT_TURNS,
  MEMORY_ITEMS,
  MEMORY_ITEM_LENGTH,
  NO_MEMORY,
  forget,
  loadConversation,
  memoryFor,
  remember,
  saveConversation,
  type SavedTurn,
} from "../src/lib/ai/memory";

// The webview's storage, as the tests' own: kept in a map.
const kept = new Map<string, string>();
globalThis.localStorage = {
  getItem: (key: string) => kept.get(key) ?? null,
  setItem: (key: string, value: string) => void kept.set(key, String(value)),
  removeItem: (key: string) => void kept.delete(key),
  clear: () => kept.clear(),
  key: (index: number) => [...kept.keys()][index] ?? null,
  get length() {
    return kept.size;
  },
} as Storage;

describe("what the AI is asked to remember", () => {
  test("is kept per vault", () => {
    const store = remember(NO_MEMORY, "/notes", "The release is called Tangerine.");
    expect(memoryFor(store, "/notes")).toEqual(["The release is called Tangerine."]);
    expect(memoryFor(store, "/other")).toEqual([]);
  });

  test("is tidied, and not kept twice or empty", () => {
    let store = remember(NO_MEMORY, null, "  Reply   briefly.  ");
    store = remember(store, null, "reply briefly.");
    store = remember(store, null, "   ");
    expect(memoryFor(store, null)).toEqual(["Reply briefly."]);
  });

  test("is cut to a length, and to a number of items - the newest kept", () => {
    expect(memoryFor(remember(NO_MEMORY, null, "x".repeat(1000)), null)[0]).toHaveLength(MEMORY_ITEM_LENGTH);
    let store = NO_MEMORY;
    for (let n = 0; n < MEMORY_ITEMS + 5; n++) store = remember(store, null, `Fact ${n}`);
    const kept = memoryFor(store, null);
    expect(kept).toHaveLength(MEMORY_ITEMS);
    expect(kept.at(-1)).toBe(`Fact ${MEMORY_ITEMS + 4}`);
  });

  test("can be forgotten, one item at a time", () => {
    let store = remember(remember(NO_MEMORY, null, "One"), null, "Two");
    store = forget(store, null, 0);
    expect(memoryFor(store, null)).toEqual(["Two"]);
  });
});

describe("the conversation, kept on this computer", () => {
  const turn = (n: number): SavedTurn => ({
    request: `Question ${n}`,
    text: `Question ${n}`,
    action: null,
    about: null,
    answer: `Answer ${n}`,
    failed: null,
    took: 1000,
  });

  beforeEach(() => localStorage.clear());

  test("comes back as it was left, per vault", () => {
    saveConversation("/notes", [turn(1), turn(2)]);
    expect(loadConversation("/notes").map((saved) => saved.request)).toEqual(["Question 1", "Question 2"]);
    expect(loadConversation("/other")).toEqual([]);
  });

  test("keeps only the latest turns", () => {
    saveConversation(
      null,
      Array.from({ length: KEPT_TURNS + 10 }, (_, n) => turn(n))
    );
    const kept = loadConversation(null);
    expect(kept).toHaveLength(KEPT_TURNS);
    expect(kept.at(-1)?.request).toBe(`Question ${KEPT_TURNS + 9}`);
  });

  test("cleared, is gone", () => {
    saveConversation("/notes", [turn(1)]);
    saveConversation("/notes", []);
    expect(loadConversation("/notes")).toEqual([]);
  });

  test("anything unreadable where it is kept is treated as nothing", () => {
    localStorage.setItem("nuza:ai-chat:/notes", "{not json");
    expect(loadConversation("/notes")).toEqual([]);
    localStorage.setItem("nuza:ai-chat:/notes", JSON.stringify([{ nope: true }, turn(1)]));
    expect(loadConversation("/notes")).toHaveLength(1);
  });
});
