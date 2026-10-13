import { describe, expect, test } from "bun:test";
import { conflictingActions, KEYMAP_ACTIONS, KeymapAction } from "../src/lib/keymaps";

/** The bindings as they ship, which is the case that must stay quiet. */
function defaults(): Record<KeymapAction, string> {
  const map = {} as Record<KeymapAction, string>;
  for (const action of KEYMAP_ACTIONS) map[action.id] = action.defaultBinding;
  return map;
}

describe("conflictingActions", () => {
  test("nothing ships on top of anything else", () => {
    expect(conflictingActions(defaults()).size).toBe(0);
  });

  // Two actions on one chord is resolved by whichever the listener reaches
  // first - an order nobody chose - so both ends of the clash are marked,
  // not just the one that lost.
  test("both sides of a clash are named, not just the loser", () => {
    const bindings = defaults();
    bindings["save-file"] = bindings["toggle-sidebar"];

    const clashing = conflictingActions(bindings);

    expect(clashing.has("save-file")).toBe(true);
    expect(clashing.has("toggle-sidebar")).toBe(true);
    expect(clashing.size).toBe(2);
  });

  test("three on one chord are all named", () => {
    const bindings = defaults();
    bindings["save-file"] = "mod+j";
    bindings["toggle-sidebar"] = "mod+j";
    bindings["open-folder"] = "mod+j";

    expect(conflictingActions(bindings).size).toBe(3);
  });

  // An action waiting for a chord has not been given one, and two of those
  // are not the same shortcut twice.
  test("an unbound action is not a clash", () => {
    const bindings = defaults();
    bindings["save-file"] = "";
    bindings["toggle-sidebar"] = "";

    expect(conflictingActions(bindings).size).toBe(0);
  });

  // Off macOS `mod` is Control, so these are one keystroke written two ways.
  // Compared as written they looked like different shortcuts, and the one the
  // listener reached second simply stopped working with nothing said about it.
  describe("mod and ctrl, which are one key off macOS", () => {
    function twoSpellings() {
      const bindings = defaults();
      bindings["save-file"] = "mod+j";
      bindings["toggle-sidebar"] = "ctrl+j";
      return bindings;
    }

    test("clash on Windows and Linux", () => {
      const clashing = conflictingActions(twoSpellings(), false);
      expect(clashing).toEqual(new Set(["save-file", "toggle-sidebar"]));
    });

    test("do not clash on macOS, where they are separate keys", () => {
      expect(conflictingActions(twoSpellings(), true).size).toBe(0);
    });

    test("a binding carrying both is the same chord as one carrying mod alone", () => {
      const bindings = defaults();
      bindings["save-file"] = "mod+ctrl+j";
      bindings["toggle-sidebar"] = "mod+j";

      expect(conflictingActions(bindings, false).size).toBe(2);
      expect(conflictingActions(bindings, true).size).toBe(0);
    });

    test("the defaults still clash with nothing on either platform", () => {
      expect(conflictingActions(defaults(), false).size).toBe(0);
      expect(conflictingActions(defaults(), true).size).toBe(0);
    });
  });
});
