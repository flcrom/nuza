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
