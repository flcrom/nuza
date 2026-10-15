import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { cn } from "cn";
import { THREAD_DAYS, type Thread } from "@/lib/ai/memory";
import { agoFor } from "@/lib/ai/time";

interface ThreadListProps {
  threads: Thread[];
  current: string;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

/** The vault's threads, newest first, to go back to one or let one go. */
export default function ThreadList({ threads, current, onOpen, onDelete, onClose }: ThreadListProps) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector<HTMLButtonElement>("button[data-thread]")?.focus();
  }, []);

  return (
    <div
      ref={list}
      role="dialog"
      aria-label="Chats"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
      className="animate-ai-in absolute inset-x-2 top-10 z-20 max-h-[60%] overflow-y-auto rounded-xl border border-zinc-700 bg-[var(--nuza-bg)] py-1 shadow-xl"
    >
      {threads.length === 0 ? (
        <p className="px-3 py-2 text-xs text-gray-500">No earlier chats in this folder.</p>
      ) : (
        <ul>
          {threads.map((thread) => (
            <li key={thread.id} className="group flex items-center">
              <button
                type="button"
                data-thread
                onClick={() => onOpen(thread.id)}
                className={cn(
                  "flex min-w-0 flex-1 cursor-pointer items-baseline gap-2 px-3 py-1.5 text-left hover:bg-zinc-800/80 focus:bg-zinc-800/80 focus:outline-none",
                  thread.id === current && "text-[var(--nuza-accent)]"
                )}
              >
                <span className={cn("truncate text-[13px]", thread.id === current ? "" : "text-gray-200")}>
                  {thread.title}
                </span>
                <span className="ml-auto shrink-0 text-[11px] text-gray-500">{agoFor(thread.updatedAt)}</span>
              </button>
              <button
                type="button"
                onClick={() => onDelete(thread.id)}
                title="Delete this chat"
                aria-label={`Delete “${thread.title}”`}
                className="mr-1.5 shrink-0 cursor-pointer rounded p-1 text-gray-600 opacity-0 hover:text-white focus:opacity-100 group-hover:opacity-100"
              >
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="border-t border-zinc-800 px-3 pt-1.5 pb-1 text-[11px] text-gray-600">
        Kept on this computer. Chats untouched for {THREAD_DAYS} days are deleted.
      </p>
    </div>
  );
}
