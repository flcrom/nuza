import { LoaderCircle } from "lucide-react";
import { PRESETS, readiness, startingNote, type Preset } from "@/lib/ai/agents";
import type { AgentConfig, Detection } from "@/lib/ai/protocol";

interface SetupChecklistProps {
  detection: Detection | null;
  /** The agent being turned on, while it starts. */
  starting: AgentConfig | null;
  /** Why turning one on did not work, if it did not. */
  error: string | null;
  onUse: (preset: Preset) => void;
  onOpenSettings: () => void;
}

const BUTTON =
  "shrink-0 cursor-pointer rounded-md bg-[var(--nuza-accent)] px-2.5 py-0.5 text-xs font-medium text-black transition-colors hover:bg-[var(--nuza-accent-strong)] disabled:cursor-default disabled:opacity-60";

/**
 * What the panel shows before any agent is turned on: one honest paragraph,
 * one button for each agent that is actually here, and the line to install
 * the rest. No modal, no second ask - `esc` goes straight back to the note.
 */
export default function SetupChecklist({
  detection,
  starting,
  error,
  onUse,
  onOpenSettings,
}: SetupChecklistProps) {
  return (
    <div className="space-y-4 text-sm">
      <div className="space-y-1.5">
        <h3 className="font-medium text-white">Bring your own agent</h3>
        <p className="text-xs leading-relaxed text-gray-400">
          nuza doesn&apos;t run its own AI. It uses an agent already on your computer, on your own plan —
          nothing to sign up for.
        </p>
      </div>
      <ul className="space-y-3">
        {PRESETS.map((preset) => {
          const found = readiness(preset, detection);
          const isStarting = starting?.kind === preset.config.kind;
          return (
            <li key={preset.id} className="space-y-1">
              <div className="flex items-center justify-between gap-3">
                <span className="text-white">{preset.label}</span>
                {found.state === "found" ? (
                  <button
                    type="button"
                    className={BUTTON}
                    disabled={starting !== null}
                    onClick={() => onUse(preset)}
                  >
                    {isStarting ? "Starting…" : "Use it"}
                  </button>
                ) : found.state === "unknown" ? (
                  <LoaderCircle size={12} className="animate-spin text-gray-500" aria-label="Looking" />
                ) : null}
              </div>
              {found.state === "missing" && (
                <p className="text-xs text-gray-500">
                  Not found. <code className="font-mono text-[11px] text-gray-300">{preset.install}</code>
                </p>
              )}
              {found.state === "needs-node" && (
                <p className="text-xs text-gray-500">Found, but it needs Node.js 22 or newer.</p>
              )}
            </li>
          );
        })}
        <li className="flex items-center justify-between gap-3">
          <span className="text-white">
            Something else <span className="text-xs text-gray-500">— any program that speaks ACP</span>
          </span>
          <button
            type="button"
            onClick={onOpenSettings}
            className="shrink-0 cursor-pointer rounded-md border border-zinc-700 bg-zinc-800 px-2.5 py-0.5 text-xs text-white hover:border-[var(--nuza-accent)]"
          >
            Set up
          </button>
        </li>
      </ul>
      {starting && <p className="text-xs text-gray-500">{startingNote(starting)}</p>}
      {error && (
        <p role="alert" className="text-xs text-amber-400">
          {error}
        </p>
      )}
    </div>
  );
}
