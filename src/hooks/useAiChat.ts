import { useCallback, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { reasonFor, report } from "@/lib/notices";
import type { AiContext } from "@/lib/ai/context";
import { buildFollowUp, buildPrompt, markedNote, type Intent } from "@/lib/ai/prompt";
import type { AgentEvent } from "@/lib/ai/protocol";
import { applyEvent, emptyAnswer, type Answer } from "@/lib/ai/transcript";

export interface ChatTurn {
  id: number;
  question: string;
  intent: Intent;
  /** What was sent about the note with this question, if anything. */
  context: AiContext | null;
  /** The exact text that went to the agent - what "what was sent" shows. */
  sent: string;
  answer: Answer;
}

export interface AskInput {
  question: string;
  context: AiContext | null;
  intent: Intent;
  model: string | null;
}

/**
 * One window's conversation with its agent: the turns so far, the one in
 * flight, and stopping it. Held only in memory - nuza keeps no record of what
 * was asked once the window has gone.
 */
export function useAiChat(agent: string) {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const nextId = useRef(0);
  /**
   * The note as this conversation was last given it. While it has not
   * changed, a follow-up does not send it again - the agent has it - and the
   * whole thing goes alongside in case the agent has lost the conversation.
   */
  const lastNote = useRef<string | null>(null);

  const update = useCallback((id: number, change: (turn: ChatTurn) => ChatTurn) => {
    setTurns((all) => all.map((turn) => (turn.id === id ? change(turn) : turn)));
  }, []);

  const running = turns.some((turn) => turn.answer.state === "streaming");

  const ask = useCallback(
    async ({ question, context, intent, model }: AskInput) => {
      const id = ++nextId.current;
      const prompt = { agent, question, context, intent };
      const full = buildPrompt(prompt);
      const note = context ? `${context.title}\n${markedNote(context)}` : "";
      const unchanged = lastNote.current !== null && lastNote.current === note;
      const sent = unchanged ? buildFollowUp(prompt) : full;
      lastNote.current = note;

      setTurns((all) => [...all, { id, question, intent, context, sent, answer: emptyAnswer() }]);

      const channel = new Channel<AgentEvent>();
      channel.onmessage = (event) => {
        // A turn that did not finish may not have reached the agent whole, so
        // the next one sends everything again.
        if (event.kind === "failed") lastNote.current = null;
        update(id, (turn) => ({ ...turn, answer: applyEvent(turn.answer, event) }));
      };
      try {
        await invoke("agent_prompt", {
          text: sent,
          inFull: unchanged ? full : null,
          model,
          onEvent: channel,
        });
      } catch (error) {
        lastNote.current = null;
        update(id, (turn) => ({
          ...turn,
          answer: { ...turn.answer, state: "failed", error: { code: "other", message: reasonFor(error) } },
        }));
      }
    },
    [agent, update]
  );

  const stop = useCallback(() => {
    invoke("agent_cancel").catch((error) => report("Couldn't stop the answer", error));
  }, []);

  /** Starts over: a new conversation, with nothing carried across. */
  const newChat = useCallback(() => {
    lastNote.current = null;
    setTurns([]);
    invoke("agent_new_chat").catch((error) => console.error("Couldn't start a new conversation:", error));
  }, []);

  return { turns, running, ask, stop, newChat };
}
