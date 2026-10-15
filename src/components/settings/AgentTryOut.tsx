import { useCallback, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { Check, LoaderCircle, X } from "lucide-react";
import { applyEvent, contextUsed, emptyAnswer, type Answer } from "@/lib/ai/transcript";
import type { AgentEvent } from "@/lib/ai/protocol";
import { report } from "@/lib/notices";

interface AgentTryOutProps {
  /** What to call the agent: its own name, never nuza's. */
  label: string;
  model: string | null;
}

/**
 * A question to the agent and its answer, as it streams, with everything
 * that comes with it: thoughts, steps, refusals. For trying an agent out from
 * Settings - the panel in the editor is where it is really used.
 */
export default function AgentTryOut({ label, model }: AgentTryOutProps) {
  const [question, setQuestion] = useState("");
  const [asked, setAsked] = useState<string | null>(null);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const running = answer?.state === "streaming";
  const latest = useRef(0);

  const ask = useCallback(async () => {
    const text = question.trim();
    if (!text || running) return;
    const turn = ++latest.current;
    setAsked(text);
    setQuestion("");
    setAnswer(emptyAnswer());

    const channel = new Channel<AgentEvent>();
    channel.onmessage = (event) => {
      if (turn === latest.current) setAnswer((current) => applyEvent(current ?? emptyAnswer(), event));
    };
    try {
      await invoke("agent_prompt", { text, model, onEvent: channel });
    } catch (error) {
      report(`Couldn't ask ${label}`, error);
      setAnswer((current) => (current ? { ...current, state: "failed" } : current));
    }
  }, [question, running, model, label]);

  const stop = useCallback(() => {
    invoke("agent_cancel").catch((error) => report("Couldn't stop the answer", error));
  }, []);

  const used = answer ? contextUsed(answer) : null;

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium text-white">Try it</h3>
      <div className="flex gap-2">
        <input
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void ask();
          }}
          placeholder={`Ask ${label} something`}
          className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-white outline-none focus:border-[var(--nuza-accent)]"
        />
        <button
          type="button"
          onClick={running ? stop : () => void ask()}
          className="cursor-pointer rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1 text-xs text-white transition-colors hover:border-[var(--nuza-accent)]"
        >
          {running ? "Stop" : "Ask"}
        </button>
      </div>

      {asked && answer && (
        <div className="space-y-1.5 rounded-md border border-zinc-800 bg-zinc-900/60 p-2 text-xs">
          <p className="text-gray-500">you</p>
          <p className="whitespace-pre-wrap text-gray-300">{asked}</p>
          <p className="pt-1 text-gray-500">{label.toLowerCase()}</p>
          {answer.parts.map((part, index) => {
            switch (part.type) {
              case "text":
                return (
                  <p key={index} className="whitespace-pre-wrap text-white">
                    {part.text}
                  </p>
                );
              case "thought":
                return (
                  <details key={index} className="text-gray-500">
                    <summary className="cursor-pointer select-none">Thinking…</summary>
                    <p className="whitespace-pre-wrap pl-3">{part.text}</p>
                  </details>
                );
              case "step":
                return (
                  <p key={index} className="flex items-center gap-1.5 text-gray-400">
                    {part.status === "completed" ? (
                      <Check size={11} aria-label="Done" />
                    ) : part.status === "failed" ? (
                      <X size={11} aria-label="Failed" />
                    ) : (
                      <LoaderCircle size={11} className="animate-spin" aria-label="Working" />
                    )}
                    {part.title}
                  </p>
                );
              case "refused":
                return (
                  <p key={index} className="text-amber-400/90">
                    nuza didn&apos;t let {label} {part.action}.
                  </p>
                );
              case "notice":
                return (
                  <p key={index} className="text-gray-400 italic">
                    {part.text}
                  </p>
                );
            }
          })}
          {answer.state === "streaming" && answer.parts.length === 0 && (
            <p className="flex items-center gap-1.5 text-gray-500">
              <LoaderCircle size={11} className="animate-spin" /> Starting {label}…
            </p>
          )}
          {answer.state === "failed" && answer.error && (
            <p role="alert" className="text-amber-400">
              {answer.error.message}
            </p>
          )}
          {answer.state === "done" && answer.stopReason === "cancelled" && (
            <p className="text-gray-500">Stopped.</p>
          )}
          {answer.state === "done" && answer.stopReason === "refusal" && (
            <p className="text-gray-500">{label} declined to answer that.</p>
          )}
          {answer.state === "done" && answer.parts.length === 0 && answer.stopReason === "end_turn" && (
            <p className="text-gray-500">{label} finished without saying anything.</p>
          )}
          {used !== null && <p className="pt-1 text-right text-gray-600">{used}% context</p>}
        </div>
      )}
    </div>
  );
}
