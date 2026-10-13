import { beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import SplitDropZone from "../src/components/SplitDropZone";
import {
  beginTabDrag,
  draggedTab,
  endTabDrag,
  releasedOutside,
  subscribe,
  takeTabDrag,
  tornOffFrame,
  wasTabDragTaken,
} from "../src/lib/tabDrag";

/** A window 900x700 whose top-left corner is at (100, 50). */
const FRAME = { screenX: 100, screenY: 50, outerWidth: 900, outerHeight: 700 };

beforeEach(() => {
  endTabDrag();
});

describe("the dragged tab", () => {
  test("is the tab a drag started on, until the drag ends", () => {
    expect(draggedTab()).toBeNull();
    beginTabDrag("/v/a.md");
    expect(draggedTab()).toBe("/v/a.md");
    endTabDrag();
    expect(draggedTab()).toBeNull();
  });

  test("announces each change once, and nothing when there is none", () => {
    let announced = 0;
    const stop = subscribe(() => announced++);

    beginTabDrag("/v/a.md");
    expect(announced).toBe(1);
    endTabDrag();
    expect(announced).toBe(2);
    // Already over: nothing changed, so nobody is woken up for it.
    endTabDrag();
    expect(announced).toBe(2);

    stop();
    beginTabDrag("/v/b.md");
    expect(announced).toBe(2);
  });
});

describe("a drag something in the app took", () => {
  test("starts untaken and stays taken until the next drag", () => {
    beginTabDrag("/v/a.md");
    expect(wasTabDragTaken()).toBe(false);
    takeTabDrag();
    expect(wasTabDragTaken()).toBe(true);
    // The flag is what tells a tear-off from a drop the strip or the split
    // took, so a fresh drag has to start out with nobody having taken it.
    beginTabDrag("/v/b.md");
    expect(wasTabDragTaken()).toBe(false);
  });

  // The split ends the drag itself, because the tab it took leaves the strip
  // and takes its `dragend` with it. Whatever `dragend` does still arrive has
  // to find the drag marked as taken, or it would tear the note off as well.
  test("stays taken after the drag has been ended", () => {
    beginTabDrag("/v/a.md");
    takeTabDrag();
    endTabDrag();
    expect(draggedTab()).toBeNull();
    expect(wasTabDragTaken()).toBe(true);
  });
});

describe("released outside the window", () => {
  test("a release anywhere inside the frame is not a tear-off", () => {
    for (const at of [
      { screenX: 100, screenY: 50 },
      { screenX: 500, screenY: 400 },
      { screenX: 1000, screenY: 750 },
    ]) {
      expect(releasedOutside(at, FRAME)).toBe(false);
    }
  });

  test("a release past any edge is", () => {
    for (const at of [
      { screenX: 99, screenY: 400 },
      { screenX: 500, screenY: 49 },
      { screenX: 1001, screenY: 400 },
      { screenX: 500, screenY: 751 },
      { screenX: 1600, screenY: 900 },
    ]) {
      expect(releasedOutside(at, FRAME)).toBe(true);
    }
  });

  // What an engine hands over when it has no position for the end of a drag.
  // A tab that tore itself out of the window on a cancelled drag would be a
  // far worse surprise than one that did nothing.
  test("a release reported at the screen's origin is not", () => {
    expect(releasedOutside({ screenX: 0, screenY: 0 }, FRAME)).toBe(false);
  });

  // A window at the origin itself still has to work, which it would not if
  // the guard above were a comparison against the frame rather than the point.
  test("a window at the origin still tears off past its edges", () => {
    const origin = { screenX: 0, screenY: 0, outerWidth: 800, outerHeight: 600 };
    expect(releasedOutside({ screenX: 400, screenY: 300 }, origin)).toBe(false);
    expect(releasedOutside({ screenX: 900, screenY: 300 }, origin)).toBe(true);
  });
});

describe("where a torn-off window goes", () => {
  test("keeps this window's size and puts the title bar under the pointer", () => {
    expect(tornOffFrame({ screenX: 1200, screenY: 300 }, FRAME)).toEqual({
      x: 1200 - 120,
      y: 300 - 24,
      width: 900,
      height: 700,
    });
  });

  test("is whole pixels, which is what the backend asks for", () => {
    const frame = tornOffFrame({ screenX: 1200.6, screenY: 300.4 }, { ...FRAME, outerWidth: 899.5 });
    for (const value of Object.values(frame)) expect(Number.isInteger(value)).toBe(true);
  });
});

describe("SplitDropZone", () => {
  // The zone is only up while a tab is in the air; the rest of the time there
  // is nothing between the pointer and the text.
  test("draws nothing when no tab is being dragged", () => {
    expect(
      renderToStaticMarkup(<SplitDropZone activePath="/v/a.md" hasSplit={false} onDrop={() => {}} />)
    ).toBe("");
  });
});
