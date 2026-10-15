/**
 * What the AI keeps between conversations, per vault, on this computer.
 *
 * Two things: what the writer asked it to remember - a few short lines sent
 * with every question - and the conversation itself, kept so a new session
 * (the app restarted, or the agent did) can pick up where the last left off.
 * Neither leaves this computer except as part of a question to the agent the
 * writer turned on, and either can be cleared.
 */

/** At most this many things to remember, each at most this long. */
export const MEMORY_ITEMS = 30;
export const MEMORY_ITEM_LENGTH = 300;
/** How many turns of a conversation are kept. */
export const KEPT_TURNS = 30;

export interface MemoryStore {
  byVault: Record<string, string[]>;
}

export const NO_MEMORY: MemoryStore = { byVault: {} };

/** The vault key a scratch note with no vault is kept under. */
const NO_VAULT = "";

export function memoryFor(store: MemoryStore, vault: string | null): string[] {
  return store.byVault[vault ?? NO_VAULT] ?? [];
}

/** `store`, with `item` remembered for `vault` - unless it already is, or is empty. */
export function remember(store: MemoryStore, vault: string | null, item: string): MemoryStore {
  const clean = item.trim().replace(/\s+/g, " ").slice(0, MEMORY_ITEM_LENGTH);
  const kept = memoryFor(store, vault);
  if (!clean || kept.some((existing) => existing.toLowerCase() === clean.toLowerCase())) return store;
  // The newest wins a place when there is no more room.
  const next = [...kept, clean].slice(-MEMORY_ITEMS);
  return { byVault: { ...store.byVault, [vault ?? NO_VAULT]: next } };
}

export function forget(store: MemoryStore, vault: string | null, index: number): MemoryStore {
  const kept = memoryFor(store, vault).filter((_, at) => at !== index);
  return { byVault: { ...store.byVault, [vault ?? NO_VAULT]: kept } };
}

/** A turn of a conversation as it is kept: what was asked, and what came back. */
export interface SavedTurn {
  /** What the agent was asked. */
  request: string;
  /** What the writer typed, shown on their message. */
  text: string;
  /** The writing action it was, if any. */
  action: string | null;
  /** The note it was about, for the chip on the message. */
  about: { title: string; lines: string | null } | null;
  /** The answer's words. */
  answer: string;
  /** Why it failed, if it did. */
  failed: string | null;
  /** How long it took, in milliseconds. */
  took: number | null;
}

/** Said on the window when a vault's conversation is cleared from Settings. */
export const CONVERSATION_CLEARED = "nuza-ai-conversation-cleared";

/** Where a vault's conversation is kept. */
export function conversationKey(vault: string | null): string {
  return `nuza:ai-chat:${vault ?? NO_VAULT}`;
}

export function loadConversation(vault: string | null): SavedTurn[] {
  try {
    const kept = localStorage.getItem(conversationKey(vault));
    const turns = kept ? (JSON.parse(kept) as SavedTurn[]) : [];
    return Array.isArray(turns) ? turns.filter((turn) => typeof turn?.request === "string") : [];
  } catch {
    return [];
  }
}

export function saveConversation(vault: string | null, turns: SavedTurn[]) {
  try {
    const key = conversationKey(vault);
    if (turns.length) localStorage.setItem(key, JSON.stringify(turns.slice(-KEPT_TURNS)));
    else localStorage.removeItem(key);
  } catch (error) {
    console.error("Couldn't keep the AI conversation:", error);
  }
}

/** A thread of conversation, kept for the vault it was had in. */
export interface Thread {
  id: string;
  /** What the first message said, for the list of threads. */
  title: string;
  /** When it was last added to, in milliseconds. */
  updatedAt: number;
  turns: SavedTurn[];
}

/** How long a thread is kept without being added to. */
export const THREAD_DAYS = 7;
/** At most this many threads per vault; the oldest go first. */
export const MAX_THREADS = 50;
const DAY = 24 * 60 * 60 * 1000;

/** Where a vault's threads are kept. */
export function threadsKey(vault: string | null): string {
  return `nuza:ai-threads:${vault ?? NO_VAULT}`;
}

/** A new thread's id: when it began, and enough else that two never meet. */
export function newThreadId(now = Date.now()): string {
  return `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** What a thread is called in the list: its first message, or the action it was. */
export function titleFor(turns: SavedTurn[]): string {
  const first = turns[0];
  if (!first) return "New chat";
  const said = first.text.trim().replace(/\s+/g, " ");
  const title = first.action ? (said ? `${first.action}: ${said}` : first.action) : said || first.request;
  const about = first.about?.title;
  const named = about && !said ? `${title} · ${about}` : title;
  return named.length > 60 ? `${named.slice(0, 59)}…` : named;
}

function isThread(value: unknown): value is Thread {
  const thread = value as Thread;
  return (
    !!thread &&
    typeof thread.id === "string" &&
    typeof thread.updatedAt === "number" &&
    Array.isArray(thread.turns)
  );
}

/**
 * A vault's threads, newest first, less any not added to for a week. The one
 * conversation kept before there were threads comes along as the first.
 */
export function loadThreads(vault: string | null, now = Date.now()): Thread[] {
  let threads: Thread[];
  try {
    const kept = localStorage.getItem(threadsKey(vault));
    const parsed: unknown = kept ? JSON.parse(kept) : [];
    threads = Array.isArray(parsed) ? parsed.filter(isThread) : [];
  } catch {
    threads = [];
  }
  const earlier = loadConversation(vault);
  if (earlier.length) {
    threads.push({ id: newThreadId(now), title: titleFor(earlier), updatedAt: now, turns: earlier });
    saveConversation(vault, []);
  }
  const fresh = threads
    .filter((thread) => now - thread.updatedAt < THREAD_DAYS * DAY)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  if (fresh.length !== threads.length || earlier.length) saveThreads(vault, fresh);
  return fresh;
}

/**
 * Keeps `threads` for `vault`. The webview keeps only a few megabytes for
 * the whole app: when they will not all fit, the oldest go until the rest
 * do, rather than nothing being kept at all.
 */
export function saveThreads(vault: string | null, threads: Thread[]) {
  const key = threadsKey(vault);
  let kept = threads
    .filter((thread) => thread.turns.length)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_THREADS)
    .map((thread) => ({ ...thread, turns: thread.turns.slice(-KEPT_TURNS) }));
  for (;;) {
    try {
      if (kept.length) localStorage.setItem(key, JSON.stringify(kept));
      else localStorage.removeItem(key);
      return;
    } catch (error) {
      if (kept.length <= 1) {
        console.error("Couldn't keep the AI threads:", error);
        return;
      }
      kept = kept.slice(0, Math.ceil(kept.length / 2));
    }
  }
}

/**
 * Clears out every vault's threads that have gone a week untouched - not
 * only the vault open now, so a folder never opened again does not keep its
 * chats for ever.
 */
export function pruneAllThreads(now = Date.now()) {
  let keys: string[];
  try {
    keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index) ?? "").filter(
      (key) => key.startsWith("nuza:ai-threads:")
    );
  } catch {
    return;
  }
  for (const key of keys) {
    const vault = key.slice("nuza:ai-threads:".length);
    loadThreads(vault === NO_VAULT ? null : vault, now);
  }
}

/** `thread` kept as it is now, in place of what was kept for it before. */
export function keepThread(vault: string | null, thread: Thread, now = Date.now()): Thread[] {
  const others = loadThreads(vault, now).filter((kept) => kept.id !== thread.id);
  const threads = thread.turns.length ? [thread, ...others] : others;
  saveThreads(vault, threads);
  return threads;
}

export function forgetThread(vault: string | null, id: string, now = Date.now()): Thread[] {
  const threads = loadThreads(vault, now).filter((kept) => kept.id !== id);
  saveThreads(vault, threads);
  return threads;
}
