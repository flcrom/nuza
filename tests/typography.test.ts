import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CONTENT_WIDTH,
  DEFAULT_EDITOR_FONT_SIZE,
  DEFAULT_LINE_HEIGHT,
  MAX_CONTENT_WIDTH,
  MAX_LINE_HEIGHT,
  MIN_CONTENT_WIDTH,
  MIN_LINE_HEIGHT,
  applyTypography,
  clampContentWidth,
  clampLineHeight,
  measureEm,
} from "../src/lib/fonts";

describe("text column width", () => {
  test("the default is the width the column has always had", () => {
    // 44rem at the app's 16px root.
    expect(DEFAULT_CONTENT_WIDTH).toBe(44 * 16);
  });

  test("is held between its limits, and whole", () => {
    expect(clampContentWidth(100)).toBe(MIN_CONTENT_WIDTH);
    expect(clampContentWidth(99999)).toBe(MAX_CONTENT_WIDTH);
    expect(clampContentWidth(800.4)).toBe(800);
    expect(clampContentWidth(Number.NaN)).toBe(DEFAULT_CONTENT_WIDTH);
  });
});

describe("line height", () => {
  test("is held between its limits", () => {
    expect(clampLineHeight(0.5)).toBe(MIN_LINE_HEIGHT);
    expect(clampLineHeight(9)).toBe(MAX_LINE_HEIGHT);
    expect(clampLineHeight(Number.NaN)).toBe(DEFAULT_LINE_HEIGHT);
  });

  // A slider and a round trip through storage are both good at this.
  test("comes back as a clean step, not a float\u2019s idea of one", () => {
    expect(clampLineHeight(1.7500000000000002)).toBe(1.75);
    expect(clampLineHeight(1.3 + 0.05 * 3)).toBe(1.45);
    expect(clampLineHeight(1.62)).toBe(1.6);
  });
});

describe("the measure in em", () => {
  // The whole point: the column is a line length in characters, so the editor's
  // own font size scales it. A measure in pixels held still while the text
  // zoomed, which fit fewer words on a line at every step.
  test("the default width is the 44em the column has always been", () => {
    expect(measureEm(DEFAULT_CONTENT_WIDTH)).toBe(44);
  });

  test("is the width divided by the default text size", () => {
    expect(measureEm(16 * 30)).toBe(30);
    expect(measureEm(DEFAULT_EDITOR_FONT_SIZE * 50)).toBe(50);
  });

  test("is held between the same limits the setting is", () => {
    expect(measureEm(10)).toBe(MIN_CONTENT_WIDTH / DEFAULT_EDITOR_FONT_SIZE);
    expect(measureEm(99999)).toBe(MAX_CONTENT_WIDTH / DEFAULT_EDITOR_FONT_SIZE);
  });

  // A width that has been through a slider and storage, divided by 16.
  test("comes back as a number, not a float’s idea of one", () => {
    expect(String(measureEm(707))).toBe("44.188");
  });
});

describe("applyTypography", () => {
  test("hands both measurements to the stylesheet, clamped", () => {
    const set = new Map<string, string>();
    const root = { style: { setProperty: (name: string, value: string) => void set.set(name, value) } };

    applyTypography(root as unknown as HTMLElement, { contentWidth: 900, lineHeight: 1.5 });
    expect(set.get("--nuza-measure")).toBe("56.25em");
    expect(set.get("--nuza-line-height")).toBe("1.5");

    applyTypography(root as unknown as HTMLElement, { contentWidth: 10, lineHeight: 50 });
    expect(set.get("--nuza-measure")).toBe(`${MIN_CONTENT_WIDTH / DEFAULT_EDITOR_FONT_SIZE}em`);
    expect(set.get("--nuza-line-height")).toBe(String(MAX_LINE_HEIGHT));
  });
});
