import { Check, ChevronRight, LoaderCircle, X } from "lucide-react";
import type { ChatTurn } from "@/hooks/useAiChat";
import type { AgentErrorKind } from "@/lib/ai/protocol";
import AnswerText from "./AnswerText";

export interface TurnActions {
  onRetry: (turn: ChatTurn) => void;
  onOpenSettings: () => void;
  onSignIn?: () => void;
}

const SMALL_BUTTON =
  "cursor-pointer rounded-md border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-xs text-white transition-colors hover:border-[var(--nuza-accent)]";

/** What can be done about a failure, right where it is said. */
function Fix({ code, turn, actions }: { code: AgentErrorKind; turn: ChatTurn; actions: TurnActions }) {
  switch (code) {
    case "agent_missing":
    case "off":
      return (
        <button type="button" className={SMALL_BUTTON} onClick={actions.onOpenSettings}>
          Open AI settings
        </button>
      );
    case "not_signed_in":
      return (
        <div className="flex gap-2">
          {actions.onSignIn && (
            <button type="button" className={SMALL_BUTTON} onClick={actions.onSignIn}>
              Sign in
            </button>
          )}
          <button type="button" className={SMALL_BUTTON} onClick={() => actions.onRetry(turn)}>
            Try again
          </button>
        </div>
      );
    case "usage_limit":
    case "model_unavailable":
      // The limit is the agent's plan's, and nuza has nothing to sell about it;
      // a model the plan lacks is changed in the picker below.
      return null;
    default:
      return (
        <button type="button" className={SMALL_BUTTON} onClick={() => actions.onRetry(turn)}>
          Retry
        </button>
      );
  }
}

interface TurnViewProps {
  turn: ChatTurn;
  /** What to call the agent: its own name, never nuza's. */
  agent: string;
  actions: TurnActions;
}

/** One question and its answer, as it streams. */
export default function TurnView({ turn, agent, actions }: TurnViewProps) {
  const { answer } = turn;
  const hasWords = answer.parts.some((part) => part.type === "text");

  return (
    <div className="space-y-1.5">
      <p className="text-[11px] uppercase tracking-wide text-gray-500">you</p>
      <p className="whitespace-pre-wrap text-gray-200">{turn.question}</p>
      <details className="group text-[11px] text-gray-600">
        <summary className="flex cursor-pointer select-none list-none items-center gap-1 hover:text-gray-400">
          <ChevronRight size={11} className="transition-transform group-open:rotate-90" />
          What was sent
        </summary>
        <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap rounded-md bg-zinc-900 p-2 font-mono text-[10px] leading-snug text-gray-400">
          {turn.sent}
        </pre>
      </details>

      <p className="pt-2 text-[11px] uppercase tracking-wide text-gray-500">{agent}</p>
      {answer.parts.map((part, index) => {
        switch (part.type) {
          case "text":
            return <AnswerText key={index} text={part.text} />;
          case "thought":
            // Open while the model is still thinking, folded away once it
            // has started to answer.
            return (
              <details
                key={index}
                open={answer.state === "streaming" && !hasWords}
                className="group text-gray-500"
              >
                <summary className="flex cursor-pointer select-none list-none items-center gap-1">
                  <ChevronRight size={12} className="transition-transform group-open:rotate-90" />
                  Thinking…
                </summary>
                <p className="whitespace-pre-wrap pl-4 text-xs">{part.text}</p>
              </details>
            );
          case "step":
            return (
              <p key={index} className="flex items-center gap-1.5 text-xs text-gray-400">
                {part.status === "completed" ? (
                  <Check size={12} aria-label="Done" className="shrink-0" />
                ) : part.status === "failed" ? (
                  <X size={12} aria-label="Failed" className="shrink-0" />
                ) : (
                  <LoaderCircle size={12} aria-label="Working" className="shrink-0 animate-spin" />
                )}
                <span className="truncate">{part.title}</span>
              </p>
            );
          case "refused":
            return (
              <p key={index} className="text-xs text-amber-400/90">
                nuza didn&apos;t let {agent} {part.action}.
              </p>
            );
          case "notice":
            return (
              <p key={index} className="text-xs italic text-gray-400">
                {part.text}
              </p>
            );
        }
      })}

      {answer.state === "streaming" && !hasWords && !answer.parts.some((part) => part.type === "thought") && (
        <p className="flex items-center gap-1.5 text-xs text-gray-500">
          <LoaderCircle size={12} className="animate-spin" />{" "}
          {answer.parts.length ? "Working…" : `Asking ${agent}…`}
        </p>
      )}
      {answer.state === "done" && answer.stopReason === "cancelled" && (
        <p className="text-xs text-gray-500">Stopped.</p>
      )}
      {answer.state === "done" && answer.stopReason === "refusal" && (
        <p className="text-xs text-gray-500">{agent} declined to answer that.</p>
      )}
      {answer.state === "done" && answer.stopReason === "max_tokens" && (
        <p className="text-xs text-gray-500">{agent} ran out of room before it finished.</p>
      )}
      {answer.state === "done" && !hasWords && answer.stopReason === "end_turn" && (
        <p className="text-xs text-gray-500">{agent} finished without saying anything.</p>
      )}
      {answer.state === "failed" && answer.error && (
        <div
          role="alert"
          className="space-y-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs"
        >
          <div className="text-amber-300">
            <AnswerText text={answer.error.message} />
          </div>
          <Fix code={answer.error.code} turn={turn} actions={actions} />
        </div>
      )}
    </div>
  );
}
