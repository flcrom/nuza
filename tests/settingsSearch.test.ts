import { describe, expect, test } from "bun:test";
import { searchSettings } from "../src/lib/settingsSearch";

const settings = [
  { title: "Vim Mode", description: "Enable Vim keybindings for the editor" },
  { title: "Line Numbers", description: "Show line numbers in the editor gutter" },
  { title: "Zen Mode", description: "Hide everything but the note" },
];

function titles(query: string) {
  return searchSettings(settings, query).map((match) => match.setting.title);
}

describe("searchSettings", () => {
  test("nothing typed lists every setting, in the order given", () => {
    expect(titles("  ")).toEqual(["Vim Mode", "Line Numbers", "Zen Mode"]);
  });

  test("matches a subsequence of the title, and says where", () => {
    const [match] = searchSettings(settings, "lnum");

    expect(match.setting.title).toBe("Line Numbers");
    expect(match.highlight).toEqual([0, 2, 6, 7]);
  });

  test("a word only the description has still finds the setting", () => {
    expect(titles("gutter")).toEqual(["Line Numbers"]);
  });

  // "editor" is in two descriptions, and loosely in no title: a subsequence
  // match over whole sentences would have returned everything.
  test("the description is matched as written, not as a subsequence", () => {
    expect(titles("editor")).toEqual(["Vim Mode", "Line Numbers"]);
    expect(titles("hdnt")).toEqual([]);
  });

  test("a hit on the title outranks one in a description", () => {
    expect(titles("vim")[0]).toBe("Vim Mode");
  });
});
