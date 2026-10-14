import { beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { conflictingActions, KEYMAP_ACTIONS, type KeymapAction } from "../src/lib/keymaps";
import { ownedHere } from "../src/hooks/useKeymaps";
import { firesWhileTyping } from "../src/lib/keybinding";

beforeAll(() => {
  const window = new Window();
  globalThis.document = window.document as unknown as Document;
  globalThis.Element = window.Element as unknown as typeof Element;
});

function defaults(): Record<KeymapAction, string> {
  const map = {} as Record<KeymapAction, string>;
  for (const action of KEYMAP_ACTIONS) map[action.id] = action.defaultBinding;
  return map;
}

describe("the AI panel's shortcuts", () => {
  test("mod+l asks, and mod+shift+l asks for a change", () => {
    expect(defaults()["toggle-ai-panel"]).toBe("mod+l");
    expect(defaults()["ai-edit-selection"]).toBe("mod+shift+l");
  });

  test("collide with nothing that ships, on either platform", () => {
    for (const isMac of [true, false]) {
      const clashing = conflictingActions(defaults(), isMac);
      expect(clashing.has("toggle-ai-panel")).toBe(false);
      expect(clashing.has("ai-edit-selection")).toBe(false);
    }
  });

  test("would be reported if they did", () => {
    const bindings = { ...defaults(), "toggle-ai-panel": "mod+k" };
    expect(conflictingActions(bindings)).toEqual(
      new Set<KeymapAction>(["toggle-ai-panel", "quick-settings"])
    );
  });

  test("fire from inside a text box, so the composer can close the panel", () => {
    expect(firesWhileTyping("mod+l")).toBe(true);
    expect(firesWhileTyping("mod+shift+l")).toBe(true);
  });
});

describe("keys the panel keeps for itself", () => {
  function pressIn(target: Element, mods: { meta?: boolean; ctrl?: boolean }, key = ".") {
    return {
      target,
      key,
      code: key === "." ? "Period" : `Key${key.toUpperCase()}`,
      metaKey: !!mods.meta,
      ctrlKey: !!mods.ctrl,
      altKey: false,
      shiftKey: false,
      getModifierState: () => false,
    } as unknown as KeyboardEvent;
  }

  function panelWithComposer() {
    const panel = document.createElement("aside");
    panel.setAttribute("data-own-keys", "mod+.");
    const composer = document.createElement("textarea");
    panel.append(composer);
    const editor = document.createElement("div");
    document.body.append(panel, editor);
    return { composer, editor };
  }

  test("mod+. in the composer is the panel's - stop - not Zen Mode", () => {
    const { composer } = panelWithComposer();
    const owned =
      ownedHere(pressIn(composer, { meta: true })) || ownedHere(pressIn(composer, { ctrl: true }));
    expect(owned).toBe(true);
  });

  test("outside the panel, mod+. is left to the window", () => {
    const { editor } = panelWithComposer();
    expect(ownedHere(pressIn(editor, { meta: true }))).toBe(false);
    expect(ownedHere(pressIn(editor, { ctrl: true }))).toBe(false);
  });

  test("every other shortcut still works from inside the panel", () => {
    const { composer } = panelWithComposer();
    expect(ownedHere(pressIn(composer, { meta: true }, "l"))).toBe(false);
    expect(ownedHere(pressIn(composer, { ctrl: true }, "l"))).toBe(false);
  });
});
