import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { ArrowUp, RotateCcw, Square, X } from "lucide-react";
import { cn } from "cn";
import { useAgent } from "@/hooks/useAgent";
import { useAiChat, type ChatTurn } from "@/hooks/useAiChat";
import { buildContext, selectionLines, type AiContext } from "@/lib/ai/context";
import { chooseModel, modelFor, type ModelChoices } from "@/lib/ai/modelChoice";
import type { Intent } from "@/lib/ai/prompt";
import type { ModelInfo } from "@/lib/ai/protocol";
import { contextUsed } from "@/lib/ai/transcript";
import { matchesBinding } from "@/lib/keybinding";
import { EditorView } from "@codemirror/view";
import {
  acceptAllProposals,
  acceptProposal,
  focusProposal,
  pendingEdits,
  rejectAllProposals,
  rejectProposal,
} from "@/lib/markdown/aiDiff";
import type { EditCard } from "@/hooks/useAiChat";
import ContextBox, { type ContextFile } from "./ContextBox";
import SetupChecklist from "./SetupChecklist";
import TurnView from "./TurnView";

/** The note a question is about, as the editor has it right now. */
export interface NoteSnapshot {
  path: string;
  text: string;
  selection: { from: number; to: number };
}

export interface AiPanelHandle {
  /** Puts the keyboard in the composer, asking (or asking for a change). */
  focusComposer: (intent: Intent) => void;
}

interface AiPanelProps {
  isOpen: boolean;
  width: number;
  isResizing: boolean;
  onResizeStart: (event: React.PointerEvent) => void;
  onResizeReset: () => void;
  /** Reads the note being asked about. Null when there is no note to ask about. */
  readNote: () => NoteSnapshot | null;
  /** The editor showing the note at `path`, if one is - where its edits are drawn and applied. */
  viewFor: (path: string) => EditorView | null;
  /** Brings the note at `path` into the editor. */
  openNote: (path: string) => Promise<void>;
  sendWholeNote: boolean;
  vaultPath: string | null;
  modelChoices: ModelChoices;
  setModelChoices: (choices: ModelChoices) => void;
  onClose: () => void;
  onReturnFocus: () => void;
  onOpenSettings: () => void;
}

/**
 * Keys the panel answers itself, and the window's shortcuts leave alone while
 * the keyboard is in here. mod+. stops an answer, where elsewhere it is Zen
 * Mode.
 */
const STOP_KEY = "mod+.";
const ACCEPT_ALL_KEY = "mod+enter";
const REJECT_ALL_KEY = "mod+backspace";
const PANEL_KEYS = [STOP_KEY, ACCEPT_ALL_KEY, REJECT_ALL_KEY].join(",");

const TOO_LONG = "This note is too long to send. Select a section instead.";

type Prepared = { ok: true; context: AiContext | null } | { ok: false; message: string };

/** What a question would send about the note, without sending it. */
function prepare(note: NoteSnapshot | null, wholeNote: boolean): Prepared {
  if (!note) return { ok: true, context: null };
  const built = buildContext({ path: note.path, text: note.text, selection: note.selection, wholeNote });
  if (!built.ok) return { ok: false, message: TOO_LONG };
  // With only the selection allowed and nothing selected, no note text goes.
  if (built.context.selectionOnly && !built.context.note) return { ok: true, context: null };
  return { ok: true, context: built.context };
}

/**
 * The AI panel, docked on the left: what the note's context is, the
 * conversation so far, and a place to ask. Only ever opened by the person,
 * with mod+L - nothing else in the app points at it.
 */
const AiPanel = forwardRef<AiPanelHandle, AiPanelProps>(function AiPanel(
  {
    isOpen,
    width,
    isResizing,
    onResizeStart,
    onResizeReset,
    readNote,
    sendWholeNote,
    vaultPath,
    modelChoices,
    setModelChoices,
    onClose,
    onReturnFocus,
    onOpenSettings,
    viewFor,
    openNote,
  },
  ref
) {
  const agent = useAgent();
  const label = agent.state?.label ?? "the agent";
  const chat = useAiChat(label, { viewFor });
  const config = agent.state?.agent ?? null;

  const [question, setQuestion] = useState("");
  const [intent, setIntent] = useState<Intent>("ask");
  const [prepared, setPrepared] = useState<Prepared>({ ok: true, context: null });
  const [models, setModels] = useState<ModelInfo[]>([]);
  const composer = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  /** Looks at the note again, for the chips. */
  const [notePath, setNotePath] = useState<string | null>(null);
  const look = useCallback(() => {
    const note = readNote();
    setPrepared(prepare(note, sendWholeNote));
    setNotePath(note?.path ?? null);
  }, [readNote, sendWholeNote]);

  useImperativeHandle(
    ref,
    () => ({
      focusComposer(next) {
        setIntent(next);
        look();
        // Once the panel is no longer `inert`, which it is until it opens.
        requestAnimationFrame(() => composer.current?.focus());
      },
    }),
    [look]
  );

  // Opening the panel is the person going looking for AI: the settings are
  // read again (they may have just turned an agent on), and either the agent
  // is started ahead of the question or what is installed is looked for.
  const { refresh, warm, detect, listModels } = agent;
  useEffect(() => {
    if (isOpen) void refresh();
  }, [isOpen, refresh]);
  useEffect(() => {
    if (!isOpen) return;
    if (!config) {
      void detect();
      return;
    }
    let current = true;
    void warm();
    void listModels().then((offered) => current && setModels(offered));
    return () => {
      current = false;
    };
  }, [isOpen, config, warm, detect, listModels]);

  // Kept at the newest words while they arrive, unless the person has
  // scrolled up to read something earlier.
  const lastTurn = chat.turns[chat.turns.length - 1];
  useEffect(() => {
    const box = scroller.current;
    if (!box) return;
    if (box.scrollHeight - box.scrollTop - box.clientHeight < 80) box.scrollTop = box.scrollHeight;
  }, [lastTurn]);

  const model = modelFor(modelChoices, config, vaultPath);

  const send = useCallback(
    (text: string, as: Intent) => {
      const asked = text.trim();
      if (!asked || chat.running || !config) return;
      const now = prepare(readNote(), sendWholeNote);
      setPrepared(now);
      if (!now.ok) return;
      setQuestion("");
      void chat.ask({
        question: asked,
        path: readNote()?.path ?? null,
        context: now.context,
        intent: as,
        model,
      });
    },
    [chat, config, readNote, sendWholeNote, model]
  );

  const retry = useCallback((turn: ChatTurn) => send(turn.question, turn.intent), [send]);

  const onComposerKey = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send(question, intent);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onReturnFocus();
    }
  };

  // mod+. anywhere in the panel stops the answer.
  /** The note a turn's edits are over, when it is in an editor. */
  const editorOf = useCallback((turn: ChatTurn) => (turn.edits ? viewFor(turn.edits.path) : null), [viewFor]);

  /** Brings a turn's note forward, then draws its edits over it. */
  const show = useCallback(
    async (turn: ChatTurn) => {
      if (!turn.edits) return;
      if (!viewFor(turn.edits.path)) await openNote(turn.edits.path);
      requestAnimationFrame(() => chat.show(turn));
    },
    [viewFor, openNote, chat]
  );

  const decide = useCallback(
    (turn: ChatTurn, card: EditCard | null, accept: boolean) => {
      const view = editorOf(turn);
      if (!view) {
        void show(turn);
        return;
      }
      if (card) {
        if (accept) acceptProposal(view, card.id);
        else rejectProposal(view, card.id);
      } else if (accept) acceptAllProposals(view);
      else rejectAllProposals(view);
    },
    [editorOf, show]
  );

  const focus = useCallback(
    (turn: ChatTurn, card: EditCard | null) => {
      const view = editorOf(turn);
      if (!view) return;
      const edit = card && pendingEdits(view.state).find((pending) => pending.id === card.id);
      view.dispatch({
        effects: [
          focusProposal.of(edit ? edit.id : null),
          ...(edit ? [EditorView.scrollIntoView(edit.from, { y: "nearest" })] : []),
        ],
      });
    },
    [editorOf]
  );

  /** The latest answer with edits still waiting - over `path`, when one is given. */
  const waitingFor = useCallback(
    (path: string | null) =>
      [...chat.turns]
        .reverse()
        .find(
          (turn) =>
            (!path || turn.edits?.path === path) &&
            turn.edits?.cards.some((card) => card.status === "pending")
        ),
    [chat.turns]
  );
  const waiting = waitingFor(null);
  /** The first edit waiting, for Review to bring into view. */
  const reviewTarget = waiting?.edits?.shown
    ? { turn: waiting, card: waiting.edits.cards.find((card) => card.status === "pending")! }
    : null;

  const onPanelKey = (event: React.KeyboardEvent) => {
    const pressed = (binding: string) => matchesBinding(event.nativeEvent, binding);
    if (pressed(STOP_KEY)) {
      event.preventDefault();
      if (chat.running) chat.stop();
    } else if ((pressed(ACCEPT_ALL_KEY) || pressed(REJECT_ALL_KEY)) && waiting) {
      // Only with edits waiting: otherwise mod+backspace is the text box's own.
      event.preventDefault();
      decide(waiting, null, pressed(ACCEPT_ALL_KEY));
    }
  };

  // The composer grows with what is typed, up to a point.
  useEffect(() => {
    const box = composer.current;
    if (!box) return;
    box.style.height = "auto";
    box.style.height = `${Math.min(box.scrollHeight, 160)}px`;
  }, [question]);

  /** The note the next question carries, and how much the edits waiting over it change. */
  const files = useMemo<ContextFile[]>(() => {
    if (!prepared.ok || !prepared.context) return [];
    const { context } = prepared;
    let detail: string | null = null;
    if (context.selection) {
      const [first, last] = selectionLines(context.note, context.selection);
      detail = first === last ? `line ${first}` : `lines ${first}–${last}`;
    }
    if (context.selectionOnly) detail = "only the selection";
    else if (context.trimmed)
      detail = `${detail ? `${detail} · ` : ""}${context.omittedLines} lines left out`;
    const lines = (text: string) => (text ? text.split("\n").length : 0);
    const pending = waitingFor(notePath)?.edits?.cards.filter((card) => card.status === "pending") ?? [];
    return [
      {
        title: context.title,
        detail,
        preview: context.note,
        added: pending.reduce((sum, card) => sum + lines(card.replace), 0),
        removed: pending.reduce((sum, card) => sum + lines(card.find), 0),
      },
    ];
  }, [prepared, notePath, waitingFor]);

  const used = lastTurn ? contextUsed(lastTurn.answer) : null;
  const signIn = config?.kind === "codex" ? () => void agent.login() : undefined;

  return (
    <aside
      data-own-keys={PANEL_KEYS}
      onKeyDown={onPanelKey}
      aria-label="AI"
      className="relative flex h-full flex-col overflow-hidden rounded-t-lg bg-[var(--nuza-editor-tint)] text-sm"
      style={{ width }}
    >
      <header className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-zinc-800/80 px-3">
        <h2 className="truncate text-xs font-medium text-gray-300">
          Ask AI{config && <span className="text-gray-500"> · {label}</span>}
        </h2>
        <div className="flex items-center gap-1">
          {config && chat.turns.length > 0 && (
            <button
              type="button"
              onClick={chat.newChat}
              disabled={chat.running}
              title="New chat"
              aria-label="New chat"
              className="cursor-pointer rounded p-1 text-gray-500 hover:bg-zinc-800 hover:text-white disabled:cursor-default disabled:opacity-40"
            >
              <RotateCcw size={13} />
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            title="Close"
            aria-label="Close the AI panel"
            className="cursor-pointer rounded p-1 text-gray-500 hover:bg-zinc-800 hover:text-white"
          >
            <X size={14} />
          </button>
        </div>
      </header>

      {!config ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <SetupChecklist
            detection={agent.detection}
            starting={agent.starting}
            error={agent.error?.message ?? null}
            onUse={(preset) => void agent.use(preset.config)}
            onOpenSettings={onOpenSettings}
          />
        </div>
      ) : (
        <>
          <div ref={scroller} className="min-h-0 flex-1 space-y-5 overflow-y-auto px-3 py-3">
            {chat.turns.length === 0 && (
              <p className="text-xs leading-relaxed text-gray-500">
                {intent === "edit"
                  ? `Say what to change, and ${label} will suggest it.`
                  : `Ask ${label} about this note${files[0]?.detail?.startsWith("line") ? ", or the part you selected" : ""}.`}
              </p>
            )}
            {chat.turns.map((turn) => (
              <TurnView
                key={turn.id}
                turn={turn}
                agent={label}
                actions={{
                  onRetry: retry,
                  onOpenSettings,
                  onSignIn: signIn,
                  onAccept: (turn, card) => decide(turn, card, true),
                  onReject: (turn, card) => decide(turn, card, false),
                  onAcceptAll: (turn) => decide(turn, null, true),
                  onRejectAll: (turn) => decide(turn, null, false),
                  onFocus: focus,
                  onShow: (turn) => void show(turn),
                }}
              />
            ))}
            {agent.error && chat.turns.length === 0 && (
              <p role="alert" className="text-xs text-amber-400">
                {agent.error.message}
              </p>
            )}
          </div>

          <div className="shrink-0 border-t border-zinc-800/80 p-2">
            {!prepared.ok && (
              <p role="alert" className="px-1 pb-1.5 text-xs text-amber-400">
                {prepared.message}
              </p>
            )}
            <ContextBox
              files={files}
              reviewable={!!reviewTarget}
              onReview={() => reviewTarget && focus(reviewTarget.turn, reviewTarget.card)}
            />
            <div className="rounded-md border border-zinc-700 bg-zinc-900/70 focus-within:border-[var(--nuza-accent)]">
              <textarea
                ref={composer}
                value={question}
                rows={2}
                onChange={(event) => setQuestion(event.target.value)}
                onKeyDown={onComposerKey}
                onFocus={look}
                placeholder={intent === "edit" ? "Describe the change…" : "Ask about this note…"}
                aria-label={intent === "edit" ? "The change you want" : "Your question"}
                className="block w-full resize-none bg-transparent px-2 pt-2 text-sm text-white outline-none placeholder:text-gray-600"
              />
              <div className="flex items-center justify-between gap-2 px-2 pb-1.5">
                {models.length > 0 ? (
                  <select
                    value={model ?? ""}
                    onChange={(event) =>
                      setModelChoices(
                        chooseModel(modelChoices, config, vaultPath, event.target.value || null)
                      )
                    }
                    aria-label="Model"
                    className="min-w-0 max-w-[60%] cursor-pointer truncate bg-transparent text-xs text-gray-500 outline-none hover:text-gray-300"
                  >
                    <option value="">Default model</option>
                    {models.map((offered) => (
                      <option key={offered.id} value={offered.id}>
                        {offered.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span />
                )}
                <div className="flex items-center gap-2">
                  {used !== null && <span className="text-[11px] text-gray-600">{used}% context</span>}
                  <button
                    type="button"
                    onClick={chat.running ? chat.stop : () => send(question, intent)}
                    disabled={!chat.running && !question.trim()}
                    title={chat.running ? "Stop" : "Send"}
                    aria-label={chat.running ? "Stop the answer" : "Send"}
                    className={cn(
                      "flex size-6 cursor-pointer items-center justify-center rounded-md transition-colors disabled:cursor-default disabled:opacity-40",
                      chat.running
                        ? "bg-zinc-700 text-white hover:bg-zinc-600"
                        : "bg-[var(--nuza-accent)] text-black hover:bg-[var(--nuza-accent-strong)]"
                    )}
                  >
                    {chat.running ? <Square size={10} fill="currentColor" /> : <ArrowUp size={13} />}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {/* The handle is on the right, against the note; dragging right widens. */}
      <div
        onPointerDown={onResizeStart}
        onDoubleClick={onResizeReset}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the AI panel"
        title="Drag to resize, double-click to reset"
        className={cn(
          "absolute -right-1 top-0 z-10 h-full w-2 cursor-col-resize after:absolute after:inset-y-0 after:right-1 after:w-px after:transition-colors",
          isResizing ? "after:bg-[var(--nuza-accent)]" : "after:bg-transparent hover:after:bg-zinc-500"
        )}
      />
    </aside>
  );
});

export default AiPanel;
