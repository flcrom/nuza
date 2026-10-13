import { useState } from "react";
import { Columns2 } from "lucide-react";
import { TAB_DRAG_TYPE, endTabDrag, takeTabDrag, useDraggedTab } from "@/lib/tabDrag";

interface SplitDropZoneProps {
  /** The note in the main pane, which cannot be put beside itself. */
  activePath: string;
  /** Whether the split is already showing something. */
  hasSplit: boolean;
  onDrop: (path: string) => void;
}

/**
 * The strip down the trailing edge of the note that opens the split.
 *
 * The split was only ever reachable from a tab's context menu, and dragging a
 * tab beside the note it should sit next to is the gesture every other editor
 * answers. So the edge of the pane becomes a drop target - for as long as a
 * tab is being dragged, and no longer, because an overlay that is always there
 * is an overlay between the pointer and the text.
 *
 * It is drawn faintly while a tab is in the air and fills in once the tab is
 * over it, so the gesture says what it will do before the mouse is let go.
 */
export default function SplitDropZone({ activePath, hasSplit, onDrop }: SplitDropZoneProps) {
  const dragged = useDraggedTab();
  const [over, setOver] = useState(false);

  // Nothing is being dragged, or what is being dragged is already the note
  // this would put it beside.
  if (!dragged || dragged === activePath) return null;

  return (
    <div
      // Scenery for a drag, not a control: there is no keyboard path through
      // it, and "Open to the Side" in the tab's menu is the one there is.
      aria-hidden
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(TAB_DRAG_TYPE)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        const path = event.dataTransfer.getData(TAB_DRAG_TYPE);
        setOver(false);
        if (!path || path === activePath) return;
        event.preventDefault();
        // Claimed before it is acted on, so the drag is not also read as the
        // tab having been let go of outside the window.
        takeTabDrag();
        // Ended here rather than left to the tab's own `dragend`, which may
        // never come: the note leaves the strip to go in the split, so the
        // element the drag started on is gone by then - and a drag that never
        // ended would leave this zone over the note for good.
        endTabDrag();
        onDrop(path);
      }}
      className={`absolute inset-y-0 right-0 z-20 flex w-2/5 items-center justify-center border-l transition-colors print:hidden ${
        over
          ? "border-[var(--nuza-accent)] bg-[var(--nuza-accent)]/10"
          : "border-dashed border-[var(--nuza-hairline)] bg-transparent"
      }`}
    >
      <span
        className={`flex items-center gap-2 rounded-md bg-zinc-900/90 px-3 py-1.5 text-xs text-zinc-300 shadow-lg transition-opacity ${
          over ? "opacity-100" : "opacity-0"
        }`}
      >
        <Columns2 size={13} />
        {hasSplit ? "Show here instead" : "Open to the side"}
      </span>
    </div>
  );
}
