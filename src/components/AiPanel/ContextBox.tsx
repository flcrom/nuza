import { useState } from "react";
import { ChevronDown, FileText } from "lucide-react";
import { cn } from "cn";

export interface ContextFile {
  /** The note's filename. */
  title: string;
  /** What of it goes: the selection's lines, only the selection, or what was left out. */
  detail: string | null;
  /** The note's text exactly as it is sent, for anyone who wants to see it. */
  preview: string;
  /** Lines the waiting edits would add and take away. */
  added: number;
  removed: number;
}

interface ContextBoxProps {
  files: ContextFile[];
  /** Whether there are edits waiting to be looked at. */
  reviewable: boolean;
  onReview: () => void;
}

function FileRow({ file }: { file: ContextFile }) {
  const [showing, setShowing] = useState(false);
  return (
    <li>
      <button
        type="button"
        onClick={() => setShowing((open) => !open)}
        title="See exactly what is sent"
        className="flex w-full cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-left hover:bg-zinc-800/60"
      >
        <FileText size={13} className="shrink-0 text-[var(--nuza-accent)]" aria-hidden />
        <span className="truncate text-gray-200">{file.title}</span>
        {file.detail && <span className="truncate text-gray-500">{file.detail}</span>}
        <span className="ml-auto flex shrink-0 gap-1 font-mono text-[11px]">
          {file.added > 0 && <span className="text-green-400">+{file.added}</span>}
          {file.removed > 0 && <span className="text-red-400">−{file.removed}</span>}
        </span>
      </button>
      {showing && (
        <pre className="animate-ai-in mx-1.5 mb-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-zinc-950/60 p-2 font-mono text-[10px] leading-snug text-gray-400">
          {file.preview}
        </pre>
      )}
    </li>
  );
}

/**
 * What the next question will carry about the note, attached to the composer:
 * the note, what of it goes, and how much the edits waiting over it change.
 * A row opens to the note's text exactly as it is sent.
 */
export default function ContextBox({ files, reviewable, onReview }: ContextBoxProps) {
  const [open, setOpen] = useState(true);
  if (!files.length) return null;
  return (
    <div className="animate-ai-in mb-1.5 rounded-md border border-zinc-800 bg-zinc-900/40 text-xs">
      <div className="flex items-center justify-between gap-2 px-1.5 py-1">
        <button
          type="button"
          onClick={() => setOpen((shown) => !shown)}
          aria-expanded={open}
          className="flex cursor-pointer items-center gap-1 rounded px-0.5 text-gray-400 hover:text-gray-200"
        >
          <ChevronDown size={13} className={cn("transition-transform", !open && "-rotate-90")} aria-hidden />
          {files.length} {files.length === 1 ? "File" : "Files"}
        </button>
        {reviewable && (
          <button
            type="button"
            onClick={onReview}
            className="cursor-pointer rounded bg-zinc-800 px-1.5 py-0.5 text-[11px] text-gray-200 hover:bg-zinc-700"
          >
            Review
          </button>
        )}
      </div>
      {open && (
        <ul className="px-0.5 pb-1">
          {files.map((file) => (
            <FileRow key={file.title} file={file} />
          ))}
        </ul>
      )}
    </div>
  );
}
