import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  History,
  PenLine,
  Replace,
  SquarePen,
  ScanText,
  SpellCheck,
  Sparkles,
  X,
} from "lucide-react";
import { cn } from "cn";
import { useAgent } from "@/hooks/useAgent";
import { useAiChat, type ChatTurn, type Selected } from "@/hooks/useAiChat";
import { buildContext, selectionLines, type AiContext } from "@/lib/ai/context";
import { agentKey, chooseModel, modelToUse, type ModelChoices } from "@/lib/ai/modelChoice";
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
import { CitationContext, type Citations } from "./citations";
import { invoke } from "@tauri-apps/api/core";
import { report } from "@/lib/notices";
import TurnView from "./TurnView";
import ThreadList from "./ThreadList";
import Composer, { type ComposerHandle } from "./Composer";
import {
  ACTIONS,
  canRun,
  parseCommand,
  requestFor,
  wordAt,
  type ActionId,
  type WritingAction,
} from "@/lib/ai/actions";

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
  /** Brings the note at `path` into the editor at `line`. */
  openAt: (path: string, line: number) => void;
  sendWholeNote: boolean;
  vaultPath: string | null;
  modelChoices: ModelChoices;
  setModelChoices: (choices: ModelChoices) => void;
  onClose: () => void;
  onReturnFocus: () => void;
  onOpenSettings: () => void;
  /** How the writer likes replies, in their own words. */
  instructions: string;
  /** What the writer asked the AI to keep in mind in this vault. */
  memory: string[];
  onRemember: (item: string) => void;
}

const CHIP_ICONS: Partial<Record<ActionId, typeof Sparkles>> = {
  rephrase: Replace,
  synonym: ScanText,
  "explain-selection": BookOpen,
  "explain-note": BookOpen,
  proofread: SpellCheck,
  improve: PenLine,
};

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
    openAt,
    instructions,
    memory,
    onRemember,
  },
  ref
) {
  const agent = useAgent();
  const label = agent.state?.label ?? "the agent";
  const chat = useAiChat(label, { viewFor, vault: vaultPath });
  const config = agent.state?.agent ?? null;

  const [question, setQuestion] = useState("");
  const [intent, setIntent] = useState<Intent>("ask");
  const [prepared, setPrepared] = useState<Prepared>({ ok: true, context: null });
  const [models, setModels] = useState<ModelInfo[]>([]);
  const composer = useRef<ComposerHandle>(null);
  const [showThreads, setShowThreads] = useState(false);
  /** What there is to act on: a selection, or at least a word at the caret. */
  const [selection, setSelection] = useState({ selected: false, onWord: false });
  /** A line from the panel itself, that goes again after a moment. */
  const [flash, setFlash] = useState<string | null>(null);
  useEffect(() => {
    if (!flash) return;
    const timer = window.setTimeout(() => setFlash(null), 3500);
    return () => window.clearTimeout(timer);
  }, [flash]);
  const scroller = useRef<HTMLDivElement>(null);

  /** Looks at the note again, for the chips. */
  const [notePath, setNotePath] = useState<string | null>(null);
  const look = useCallback(() => {
    const note = readNote();
    setPrepared(prepare(note, sendWholeNote));
    setNotePath(note?.path ?? null);
    const selected = !!note && note.selection.to > note.selection.from;
    const onWord = !!note && !selected && !!wordAt(note.text, note.selection.from);
    setSelection({ selected, onWord });
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
  // Another agent's models mean nothing to this one: until this one has
  // said what it offers, there are none to pick from.
  const agentNow = agentKey(config);
  const [modelsFor, setModelsFor] = useState(agentNow);
  if (modelsFor !== agentNow) {
    setModelsFor(agentNow);
    setModels([]);
  }
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

  const model = modelToUse(modelChoices, config, vaultPath, models);

  /** Asks the agent `question`, about the note as it is now - or as `note` says it is. */
  const ask = useCallback(
    (
      question: string,
      shown: { text: string; action: string | null },
      as: Intent,
      note = readNote(),
      selected: Selected | null = null
    ) => {
      if (chat.running || !config) return;
      const now = prepare(note, sendWholeNote);
      setPrepared(now);
      if (!now.ok) return;
      setQuestion("");
      const context = now.context;
      let lines: string | null = null;
      if (context?.selection) {
        const [first, last] = selectionLines(context.note, context.selection);
        lines = first === last ? `L${first}` : `L${first}-${last}`;
      }
      void chat.ask({
        question,
        text: shown.text,
        action: shown.action,
        about: context ? { title: context.title, lines } : null,
        instructions,
        memory,
        path: note?.path ?? null,
        context,
        intent: as,
        model,
        selected,
      });
    },
    [chat, config, readNote, sendWholeNote, model, instructions, memory]
  );

  /** Runs a writing action on what is selected - or, for a synonym, the word at the caret. */
  const run = useCallback(
    (action: WritingAction, rest: string) => {
      if (action.id === "remember") {
        if (!rest) {
          setFlash("Type what to remember after /remember.");
          return;
        }
        onRemember(rest);
        setQuestion("");
        setFlash("Remembered. It goes with every question in this vault.");
        return;
      }
      let note = readNote();
      let selected = !!note && note.selection.to > note.selection.from;
      if (note && !selected && action.needs === "word") {
        const word = wordAt(note.text, note.selection.from);
        if (word) {
          note = { ...note, selection: word };
          selected = true;
        }
      }
      if (!canRun(action, selected, false)) {
        setFlash(action.needs === "word" ? "Put the caret on a word first." : "Select some text first.");
        return;
      }
      // A change to what is selected stays inside it, however often the same
      // words appear elsewhere in the note.
      const scoped =
        note && selected && action.intent === "edit"
          ? {
              from: note.selection.from,
              to: note.selection.to,
              text: note.text.slice(note.selection.from, note.selection.to),
            }
          : null;
      ask(
        requestFor(action, selected, rest),
        { text: rest, action: action.label },
        action.intent,
        note,
        scoped
      );
    },
    [ask, onRemember, readNote]
  );

  /** Sends what was typed: a writing action when it starts with one, a question otherwise. */
  const send = useCallback(
    (text: string) => {
      const asked = text.trim();
      if (!asked) return;
      const command = parseCommand(asked);
      if (command) run(command.action, command.rest);
      else ask(asked, { text: asked, action: null }, intent);
    },
    [ask, run, intent]
  );

  const retry = useCallback(
    (turn: ChatTurn) => ask(turn.question, { text: turn.text, action: turn.action }, turn.intent),
    [ask]
  );

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

  // The notes the agent has been shown, which its citations may open - asked
  // again whenever an answer finishes.
  const [citable, setCitable] = useState<ReadonlySet<string>>(new Set());
  const lastState = lastTurn?.answer.state;
  useEffect(() => {
    if (lastState !== "done") return;
    invoke<string[]>("agent_citable")
      .then((paths) => setCitable(new Set(paths)))
      .catch(() => setCitable(new Set()));
  }, [lastState, lastTurn?.id]);
  const citations = useMemo<Citations>(
    () => ({
      citable,
      open(path, paragraph) {
        invoke<{ path: string; line: number }>("agent_cite", { path, paragraph })
          .then((cited) => openAt(cited.path, cited.line))
          .catch((error) => report("Couldn't open that note", error));
      },
    }),
    [citable, openAt]
  );
  const cannotSearch =
    agent.state?.vaultSearch && agent.state.agentSearches === false
      ? `${label} can't search your vault, so nuza is sending the note text instead.`
      : null;

  return (
    <CitationContext.Provider value={citations}>
      <aside
        data-own-keys={PANEL_KEYS}
        onKeyDown={onPanelKey}
        aria-label="AI"
        className="relative flex h-full flex-col overflow-hidden rounded-t-lg bg-[var(--nuza-editor-tint)] text-sm"
        style={{ width }}
      >
        <header className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-zinc-800/80 px-3">
          <h2 className="truncate text-xs font-medium text-gray-300">{config ? label : "AI"}</h2>
          <div className="flex items-center gap-1">
            {config && (
              <button
                type="button"
                onClick={() => setShowThreads((shown) => !shown)}
                title="Chats"
                aria-label="Chats"
                aria-expanded={showThreads}
                className={cn(
                  "cursor-pointer rounded p-1 hover:bg-zinc-800 hover:text-white",
                  showThreads ? "text-white" : "text-gray-500"
                )}
              >
                <History size={13} />
              </button>
            )}
            {config && chat.turns.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setShowThreads(false);
                  chat.newChat();
                }}
                disabled={chat.running}
                title="New chat"
                aria-label="New chat"
                className="cursor-pointer rounded p-1 text-gray-500 hover:bg-zinc-800 hover:text-white disabled:cursor-default disabled:opacity-40"
              >
                <SquarePen size={13} />
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

        {config && showThreads && (
          <ThreadList
            threads={chat.threads}
            current={chat.threadId}
            onOpen={(id) => {
              setShowThreads(false);
              if (!chat.running) chat.openThread(id);
              requestAnimationFrame(() => composer.current?.focus());
            }}
            onDelete={chat.deleteThread}
            onNew={
              chat.turns.length > 0 && !chat.running
                ? () => {
                    setShowThreads(false);
                    chat.newChat();
                    requestAnimationFrame(() => composer.current?.focus());
                  }
                : undefined
            }
            onClose={() => {
              setShowThreads(false);
              composer.current?.focus();
            }}
          />
        )}

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
                <div className="animate-ai-in space-y-3 pt-2">
                  <p className="text-[13px] text-gray-300">
                    {intent === "edit" ? "What should change?" : "What can I help with?"}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {ACTIONS.filter(
                      (action) =>
                        action.id !== "remember" && canRun(action, selection.selected, selection.onWord)
                    )
                      .filter((action) => (selection.selected ? action.id !== "explain-note" : true))
                      .map((action) => {
                        const Icon = CHIP_ICONS[action.id] ?? Sparkles;
                        return (
                          <button
                            key={action.id}
                            type="button"
                            title={action.hint}
                            onClick={() => run(action, "")}
                            className="flex cursor-pointer items-center gap-1.5 rounded-full border border-zinc-700/80 bg-zinc-800/40 px-2.5 py-1 text-xs text-gray-300 transition-colors hover:border-[var(--nuza-accent)] hover:text-white"
                          >
                            <Icon size={12} aria-hidden />
                            {action.label}
                          </button>
                        );
                      })}
                  </div>
                  <p className="text-[11px] text-gray-600">
                    {selection.selected ? "These work on what you selected. " : ""}Type / for every action.
                  </p>
                </div>
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
                    onCreateNote: (turn, note) => {
                      invoke<string>("create_note", { path: note.path, content: note.content })
                        .then((made) => {
                          chat.markNote(turn.id, note.id, "created");
                          void openNote(made);
                        })
                        .catch((error) => chat.markNote(turn.id, note.id, "failed", String(error)));
                    },
                    onDiscardNote: (turn, note) => chat.markNote(turn.id, note.id, "discarded"),
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
                notice={cannotSearch}
              />
              {flash && <p className="animate-ai-in px-1 pb-1.5 text-xs text-gray-400">{flash}</p>}
              <Composer
                ref={composer}
                value={question}
                onChange={setQuestion}
                onSend={send}
                onStop={chat.stop}
                onAction={run}
                onEscape={onReturnFocus}
                onFocus={look}
                running={chat.running}
                intent={intent}
                selected={selection.selected}
                onWord={selection.onWord}
                models={models}
                model={model}
                onModel={(chosen) => setModelChoices(chooseModel(modelChoices, config, vaultPath, chosen))}
                used={used}
              />
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
    </CitationContext.Provider>
  );
});

export default AiPanel;
