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
  THREAD_DAYS,
  forgetThread,
  keepThread,
  loadThreads,
  saveThreads,
  titleFor,
  type SavedTurn,
  type Thread,
} from "../src/lib/ai/memory";
import { agoFor, tookFor } from "../src/lib/ai/time";

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

describe("chat threads, kept per vault", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.UTC(2026, 9, 15, 12);
  const turn = (text: string, action: string | null = null): SavedTurn => ({
    request: text || "the action's request",
    text,
    action,
    about: { title: "weblog.md", lines: "L29" },
    answer: "An answer.",
    failed: null,
    took: 1000,
  });
  const thread = (id: string, daysAgo: number, text = id): Thread => ({
    id,
    title: text,
    updatedAt: now - daysAgo * DAY,
    turns: [turn(text)],
  });

  beforeEach(() => localStorage.clear());

  test("come back newest first", () => {
    saveThreads("/notes", [thread("older", 3), thread("newer", 1)]);
    expect(loadThreads("/notes", now).map((kept) => kept.id)).toEqual(["newer", "older"]);
    expect(loadThreads("/other", now)).toEqual([]);
  });

  test(`one untouched for ${THREAD_DAYS} days is deleted`, () => {
    saveThreads("/notes", [thread("fresh", THREAD_DAYS - 1), thread("stale", THREAD_DAYS + 1)]);
    expect(loadThreads("/notes", now).map((kept) => kept.id)).toEqual(["fresh"]);
    // And gone from where they are kept, not only from the list.
    expect(localStorage.getItem("nuza:ai-threads:/notes")).not.toContain("stale");
  });

  test("the one conversation kept before threads becomes the first, once", () => {
    saveConversation("/notes", [turn("What is this note?")]);
    const threads = loadThreads("/notes", now);
    expect(threads).toHaveLength(1);
    expect(threads[0].title).toBe("What is this note?");
    expect(loadConversation("/notes")).toEqual([]);
    expect(loadThreads("/notes", now)).toHaveLength(1);
  });

  test("a thread kept again replaces what was kept for it, and goes to the top", () => {
    saveThreads("/notes", [thread("a", 2), thread("b", 1)]);
    const updated = { ...thread("a", 0), turns: [turn("a"), turn("and then")] };
    const threads = keepThread("/notes", updated, now);
    expect(threads.map((kept) => kept.id)).toEqual(["a", "b"]);
    expect(loadThreads("/notes", now)[0].turns).toHaveLength(2);
  });

  test("a thread with nothing in it is not kept", () => {
    expect(keepThread("/notes", { ...thread("empty", 0), turns: [] }, now)).toEqual([]);
  });

  test("one can be deleted", () => {
    saveThreads("/notes", [thread("a", 2), thread("b", 1)]);
    expect(forgetThread("/notes", "a", now).map((kept) => kept.id)).toEqual(["b"]);
  });

  test("is called by what was said first, or by the action and the note", () => {
    expect(titleFor([turn("Is the timeline realistic?")])).toBe("Is the timeline realistic?");
    expect(titleFor([turn("", "Synonym")])).toBe("Synonym · weblog.md");
    expect(titleFor([turn("make it shorter", "Rephrase")])).toBe("Rephrase: make it shorter");
    expect(titleFor([turn("x".repeat(100))])).toHaveLength(60);
  });
});

describe("times, as a person says them", () => {
  test("how long ago", () => {
    const now = 10 * 24 * 60 * 60 * 1000;
    expect(agoFor(now - 20_000, now)).toBe("just now");
    expect(agoFor(now - 5 * 60_000, now)).toBe("5m ago");
    expect(agoFor(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(agoFor(now - 2 * 86_400_000, now)).toBe("2d ago");
  });

  test("how long it took", () => {
    expect(tookFor(400)).toBe("1s");
    expect(tookFor(12_400)).toBe("12s");
    expect(tookFor(75_000)).toBe("1m 15s");
  });
});
