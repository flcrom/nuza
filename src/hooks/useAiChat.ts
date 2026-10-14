import { useCallback, useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import type { EditorView } from "@codemirror/view";
import { reasonFor, report } from "@/lib/notices";
import type { AiContext } from "@/lib/ai/context";
import { buildFollowUp, buildPrompt, markedNote, type Intent } from "@/lib/ai/prompt";
import type { AgentEvent } from "@/lib/ai/protocol";
import {
  afterRetry,
  againstLiveNote,
  hasEditsBlock,
  parseProposals,
  retryRequest,
  type Proposal,
} from "@/lib/ai/proposals";
import { applyEvent, answerText, emptyAnswer, type Answer } from "@/lib/ai/transcript";
import { PROPOSAL_EVENT, setProposals, type ProposalEventDetail } from "@/lib/markdown/aiDiff";

/**
 * Where a proposed edit stands: waiting over the note, taken, turned down,
 * no longer matching the note, or replaced by a newer answer's edits.
 */
export type EditStatus = "pending" | "accepted" | "rejected" | "stale" | "replaced";

export interface EditCard {
  id: string;
  find: string;
  replace: string;
  why: string;
  status: EditStatus;
}

export interface TurnEdits {
  /** The note they are for. */
  path: string;
  cards: EditCard[];
  /** Waiting on the one retry, for edits whose text did not line up. */
  aligning: boolean;
  /** Whether they are drawn over the note yet - not while it is not open. */
  shown: boolean;
  /** Something to say about edits that could not be shown. */
  problem: string | null;
}

export interface ChatTurn {
  id: number;
  question: string;
  intent: Intent;
  /** What was sent about the note with this question, if anything. */
  context: AiContext | null;
  answer: Answer;
  edits: TurnEdits | null;
}

export interface AskInput {
  question: string;
  /** The note the question is about, for its edits to go over. */
  path: string | null;
  context: AiContext | null;
  intent: Intent;
  model: string | null;
}

export interface NoteAccess {
  /** The editor showing the note at `path`, if one is. */
  viewFor: (path: string) => EditorView | null;
}

const PROBLEMS: Record<string, string> = {
  malformed: "The suggested changes couldn't be read, so none are shown.",
  "too-many": "The agent suggested too many changes at once, so none are shown. Ask for fewer.",
  "too-long":
    "A suggested change was too long to line up safely, so none are shown. Select a smaller section.",
  overlap: "The suggested changes overlapped each other, so none are shown.",
};

function cardsFor(proposals: Proposal[], status: EditStatus): EditCard[] {
  return proposals.map(({ id, find, replace, why }) => ({ id, find, replace, why, status }));
}

/** Runs one prompt, passing its events to `onEvent`, and gives back its final answer. */
async function prompt(
  text: string,
  inFull: string | null,
  model: string | null,
  onEvent: (event: AgentEvent) => void
): Promise<Answer> {
  let answer = emptyAnswer();
  const channel = new Channel<AgentEvent>();
  channel.onmessage = (event) => {
    answer = applyEvent(answer, event);
    onEvent(event);
  };
  try {
    await invoke("agent_prompt", { text, inFull, model, onEvent: channel });
  } catch (error) {
    answer = { ...answer, state: "failed", error: { code: "other", message: reasonFor(error) } };
  }
  return answer;
}

/**
 * One window's conversation with its agent: the turns so far, the one in
 * flight, the edits each answer proposed, and stopping it. Held only in
 * memory - nuza keeps no record of what was asked once the window has gone.
 */
export function useAiChat(agent: string, access: NoteAccess) {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const nextId = useRef(0);
  const notes = useRef(access);
  notes.current = access;
  /**
   * The note as this conversation was last given it. While it has not
   * changed, a follow-up does not send it again - the agent has it - and the
   * whole thing goes alongside in case the agent has lost the conversation.
   */
  const lastNote = useRef<string | null>(null);
  /** Edits turned down since the last question, to be mentioned in the next. */
  const declined = useRef<{ find: string; replace: string }[]>([]);
  const cards = useRef(new Map<string, EditCard>());

  const update = useCallback((id: number, change: (turn: ChatTurn) => ChatTurn) => {
    setTurns((all) => all.map((turn) => (turn.id === id ? change(turn) : turn)));
  }, []);

  const updateEdits = useCallback(
    (id: number, change: Partial<TurnEdits>) =>
      update(id, (turn) => (turn.edits ? { ...turn, edits: { ...turn.edits, ...change } } : turn)),
    [update]
  );

  // A proposal leaving the note - accepted or rejected from the note itself,
  // or typed over - is said on its card.
  useEffect(() => {
    function onDecided(event: Event) {
      const { id, outcome } = (event as CustomEvent<ProposalEventDetail>).detail;
      const card = cards.current.get(id);
      if (!card || card.status !== "pending") return;
      const status: EditStatus = outcome === "dropped" ? "stale" : outcome;
      if (status === "rejected") declined.current.push({ find: card.find, replace: card.replace });
      card.status = status;
      setTurns((all) =>
        all.map((turn) =>
          turn.edits?.cards.some((c) => c.id === id)
            ? {
                ...turn,
                edits: {
                  ...turn.edits,
                  cards: turn.edits.cards.map((c) => (c.id === id ? { ...c, status } : c)),
                },
              }
            : turn
        )
      );
    }
    window.addEventListener(PROPOSAL_EVENT, onDecided);
    return () => window.removeEventListener(PROPOSAL_EVENT, onDecided);
  }, []);

  /**
   * Draws a turn's edits over its note, checked against the note as it is
   * now: anything the person has since typed over is set aside, not moved.
   * Earlier answers' edits still waiting are replaced by these.
   */
  const place = useCallback(
    (id: number, path: string, proposals: Proposal[], problem: string | null) => {
      const view = notes.current.viewFor(path);
      if (!view) {
        const waiting = cardsFor(proposals, "pending");
        for (const card of waiting) cards.current.set(card.id, card);
        updateEdits(id, { cards: waiting, aligning: false, shown: false, problem });
        return;
      }
      const { fresh, stale } = againstLiveNote(proposals, view.state.doc.toString());
      // Older edits still waiting give way to these.
      setTurns((all) =>
        all.map((turn) =>
          turn.id !== id && turn.edits?.cards.some((card) => card.status === "pending")
            ? {
                ...turn,
                edits: {
                  ...turn.edits,
                  cards: turn.edits.cards.map((card) =>
                    card.status === "pending" ? { ...card, status: "replaced" as const } : card
                  ),
                },
              }
            : turn
        )
      );
      for (const card of cards.current.values()) if (card.status === "pending") card.status = "replaced";
      const shown = [...cardsFor(fresh, "pending"), ...cardsFor(stale, "stale")];
      for (const card of shown) cards.current.set(card.id, card);
      view.dispatch({
        effects: setProposals.of(
          fresh.map(({ id, from, to, replace, why }) => ({ id, from, to, replace, why }))
        ),
      });
      const allStale = !fresh.length && stale.length > 0;
      updateEdits(id, {
        cards: shown,
        aligning: false,
        shown: true,
        problem: allStale ? "The note has changed since, so these no longer match it." : problem,
      });
    },
    [updateEdits]
  );

  /** Reads a finished answer's edits, with the one retry for anchors that did not line up. */
  const settle = useCallback(
    async (id: number, path: string, context: AiContext, answer: Answer, model: string | null) => {
      const text = answerText(answer);
      if (!hasEditsBlock(text)) return;
      update(id, (turn) => ({
        ...turn,
        edits: { path, cards: [], aligning: false, shown: false, problem: null },
      }));
      const parsed = parseProposals(text, context.note);
      if (parsed.ok) {
        place(id, path, parsed.proposals, null);
        return;
      }
      if (parsed.reason !== "anchor-missing" && parsed.reason !== "anchor-ambiguous") {
        updateEdits(id, { problem: PROBLEMS[parsed.reason] ?? null });
        return;
      }

      // One retry, never two, and not shown as a question of its own.
      updateEdits(id, { aligning: true });
      const failed = parsed.failed ?? [];
      const retry = await prompt(retryRequest(failed), null, model, () => {});
      const { proposals, unplaced } =
        retry.state === "done"
          ? afterRetry(parsed.resolved ?? [], failed.length, answerText(retry), context.note)
          : { proposals: parsed.resolved ?? [], unplaced: failed.length };
      const problem = unplaced
        ? `I couldn't line ${unplaced === 1 ? "one change" : `${unplaced} changes`} up with your note — try selecting a smaller section.`
        : null;
      if (proposals.length) place(id, path, proposals, problem);
      else updateEdits(id, { aligning: false, problem });
    },
    [place, update, updateEdits]
  );

  const running = turns.some((turn) => turn.answer.state === "streaming" || turn.edits?.aligning);

  const ask = useCallback(
    async ({ question, path, context, intent, model }: AskInput) => {
      const id = ++nextId.current;
      const input = { agent, question, context, intent, declined: declined.current };
      const full = buildPrompt(input);
      const note = context ? `${context.title}\n${markedNote(context)}` : "";
      const unchanged = lastNote.current !== null && lastNote.current === note;
      const sent = unchanged ? buildFollowUp(input) : full;
      lastNote.current = note;
      declined.current = [];

      setTurns((all) => [...all, { id, question, intent, context, answer: emptyAnswer(), edits: null }]);

      const answer = await prompt(sent, unchanged ? full : null, model, (event) => {
        // A turn that did not finish may not have reached the agent whole, so
        // the next one sends everything again.
        if (event.kind === "failed") lastNote.current = null;
        update(id, (turn) => ({ ...turn, answer: applyEvent(turn.answer, event) }));
      });
      if (answer.state === "failed") {
        lastNote.current = null;
        update(id, (turn) => ({ ...turn, answer: turn.answer.state === "failed" ? turn.answer : answer }));
        return;
      }
      if (answer.state === "done" && context && path) await settle(id, path, context, answer, model);
    },
    [agent, update, settle]
  );

  /** Draws a turn's edits over its note, once that note is open. */
  const show = useCallback(
    (turn: ChatTurn) => {
      if (!turn.edits) return;
      const waiting = turn.edits.cards.filter((card) => card.status === "pending");
      const view = notes.current.viewFor(turn.edits.path);
      if (!view || !waiting.length) return;
      // Found again from their text: where they were is from the note as it was.
      const live = view.state.doc.toString();
      const proposals = waiting.flatMap((card) => {
        const from = live.indexOf(card.find);
        return [{ ...card, from, to: from + card.find.length }];
      });
      place(turn.id, turn.edits.path, proposals, turn.edits.problem);
    },
    [place]
  );

  const stop = useCallback(() => {
    invoke("agent_cancel").catch((error) => report("Couldn't stop the answer", error));
  }, []);

  /** Starts over: a new conversation, with nothing carried across. */
  const newChat = useCallback(() => {
    lastNote.current = null;
    declined.current = [];
    setTurns([]);
    invoke("agent_new_chat").catch((error) => console.error("Couldn't start a new conversation:", error));
  }, []);

  return { turns, running, ask, show, stop, newChat };
}
