import { useSyncExternalStore } from "react";

/**
 * A tab being dragged, and what the rest of the app needs to know about it.
 *
 * Module state rather than React state, for the same reason `dragSource` is:
 * a tab dragged out of the strip is answered by things that are nowhere near
 * it - the drop zone over the note, and the window itself - and `dragover`
 * cannot read the drag's own `DataTransfer`, so the one place they can all
 * meet is here. `types` can be read during a drag, which is what the drop
 * targets check; the path itself only comes back on the drop.
 *
 * Its own MIME type rather than text, so a tab let go of over the note or the
 * sidebar is nothing to them - neither writes its path into the note nor tries
 * to move a file.
 */
export const TAB_DRAG_TYPE = "application/x-nuza-tab";

let dragged: string | null = null;
/**
 * Set when something inside the app has taken the drop: another tab, for a
 * reorder, or the split. What is left - a drag that ended with nobody taking
 * it - is how a tab dropped outside the window is told from one dropped on a
 * target that simply declined it.
 */
let taken = false;

const listeners = new Set<() => void>();

function announce() {
  for (const listener of listeners) listener();
}

/** Exported so that how often a drag announces itself can be tested. */
export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Ends a drag the engine never said had ended. A drop can come and go with no
 * `dragend` after it - WebKit drops it now and then - and the drag was then
 * left running: its tab faded, the marker standing where it would have gone,
 * until the app was restarted. The first time the pointer moves with no
 * button held, or is pressed again, the drag is over whatever was said.
 * Neither happens during a drag, which has the mouse to itself until it ends.
 */
function strayMove(event: MouseEvent) {
  if (event.buttons === 0) endTabDrag();
}
function strayPress() {
  endTabDrag();
}

function watchForStrayEnd(on: boolean) {
  if (typeof window === "undefined") return;
  if (on) {
    window.addEventListener("mousemove", strayMove, true);
    window.addEventListener("mousedown", strayPress, true);
  } else {
    window.removeEventListener("mousemove", strayMove, true);
    window.removeEventListener("mousedown", strayPress, true);
  }
}

export function beginTabDrag(path: string) {
  dragged = path;
  taken = false;
  watchForStrayEnd(true);
  announce();
}

/** Called by whichever drop target took the tab, before it acts on it. */
export function takeTabDrag() {
  taken = true;
}

export function wasTabDragTaken() {
  return taken;
}

export function endTabDrag() {
  if (dragged === null) return;
  dragged = null;
  watchForStrayEnd(false);
  announce();
}

export function draggedTab() {
  return dragged;
}

/** The tab being dragged, for a component that shows itself only during one. */
export function useDraggedTab() {
  return useSyncExternalStore(
    subscribe,
    () => dragged,
    () => null
  );
}

/** Where a window is on screen, and how big - the part of `window` this needs. */
export interface WindowFrame {
  screenX: number;
  screenY: number;
  outerWidth: number;
  outerHeight: number;
}

/** Where a drag ended, in screen coordinates. */
export interface ReleasePoint {
  screenX: number;
  screenY: number;
}

/**
 * Whether a drag ended outside `frame`.
 *
 * Screen coordinates rather than `clientX`/`clientY`: those are relative to
 * the viewport and stop meaning anything useful once the pointer has left the
 * webview, where this is the one question worth asking.
 *
 * A release reported at the screen's own origin is not treated as outside. It
 * is what an engine hands over when it has no position to give for the end of
 * a drag, and a tab that quietly tore itself out of the window on a cancelled
 * drag would be a far worse surprise than one that did nothing.
 */
export function releasedOutside(at: ReleasePoint, frame: WindowFrame) {
  if (at.screenX === 0 && at.screenY === 0) return false;
  return (
    at.screenX < frame.screenX ||
    at.screenY < frame.screenY ||
    at.screenX > frame.screenX + frame.outerWidth ||
    at.screenY > frame.screenY + frame.outerHeight
  );
}

/** This window, as `releasedOutside` wants it. */
export function windowFrame(view: Window = window): WindowFrame {
  return {
    screenX: view.screenX,
    screenY: view.screenY,
    outerWidth: view.outerWidth,
    outerHeight: view.outerHeight,
  };
}

/**
 * Where a window torn off at `at` should be put: the same size as this one,
 * with its title bar under the pointer rather than its top-left corner, which
 * is where the tab was being held.
 *
 * The backend checks the result against the screens that are actually there
 * and falls back to cascading the window beside this one, so a release in a
 * place no window could be reached at is not a window that cannot be reached.
 */
export function tornOffFrame(at: ReleasePoint, frame: WindowFrame = windowFrame()) {
  /** How far into the window the pointer is taken to have been holding the tab. */
  const GRIP = { x: 120, y: 24 };
  return {
    x: Math.round(at.screenX - GRIP.x),
    y: Math.round(at.screenY - GRIP.y),
    width: Math.round(frame.outerWidth),
    height: Math.round(frame.outerHeight),
  };
}
