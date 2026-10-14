import { describe, expect, test } from "bun:test";
import {
  MAX_AI_PANEL_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_AI_PANEL_WIDTH,
  MIN_SIDEBAR_WIDTH,
  clampAiPanelWidth,
  clampWidth,
  widthAfterDrag,
} from "../src/hooks/useResizableSidebar";

describe("sidebar width", () => {
  // The four view names need this much to read in full.
  test("is never narrower than its view names need", () => {
    expect(MIN_SIDEBAR_WIDTH).toBeGreaterThanOrEqual(224);
    expect(clampWidth(40)).toBe(MIN_SIDEBAR_WIDTH);
  });

  // A width kept by a build with a narrower minimum comes back within today's.
  test("a width from storage is held to the limits", () => {
    expect(clampWidth(160)).toBe(MIN_SIDEBAR_WIDTH);
    expect(clampWidth(300)).toBe(300);
    expect(clampWidth(9000)).toBe(MAX_SIDEBAR_WIDTH);
    expect(clampWidth(Number.NaN)).toBeGreaterThanOrEqual(MIN_SIDEBAR_WIDTH);
  });
});

describe("a panel dragged wider", () => {
  test("on the right grows as the pointer moves left", () => {
    expect(widthAfterDrag("right", 240, 1000, 960)).toBe(280);
  });

  test("on the left grows as the pointer moves right", () => {
    expect(widthAfterDrag("left", 360, 400, 440)).toBe(400);
  });

  test("the AI panel is held between its own limits", () => {
    expect(clampAiPanelWidth(100)).toBe(MIN_AI_PANEL_WIDTH);
    expect(clampAiPanelWidth(9000)).toBe(MAX_AI_PANEL_WIDTH);
    expect(MIN_AI_PANEL_WIDTH).toBe(300);
    expect(MAX_AI_PANEL_WIDTH).toBe(560);
  });
});
