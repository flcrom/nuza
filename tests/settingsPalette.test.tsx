import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import SettingsPalette from "../src/components/SettingsPalette";

const settings = [
  { id: "vim-mode", title: "Vim Mode", description: "Enable Vim keybindings", enabled: true, onToggle() {} },
  {
    id: "line-numbers",
    title: "Line Numbers",
    description: "Show line numbers",
    enabled: false,
    onToggle() {},
  },
];

describe("SettingsPalette", () => {
  test("closed, it is not on the page at all", () => {
    expect(
      renderToStaticMarkup(<SettingsPalette isOpen={false} onClose={() => {}} settings={settings} />)
    ).toBe("");
  });

  test("open, every switch is listed with the state it is in", () => {
    const markup = renderToStaticMarkup(<SettingsPalette isOpen onClose={() => {}} settings={settings} />);

    expect(markup).toContain("Vim Mode");
    expect(markup).toContain("Line Numbers");
    expect(markup.match(/aria-checked="true"/g)?.length).toBeGreaterThanOrEqual(1);
    expect(markup).toMatch(/role="option"[^>]*aria-checked="false"/);
  });
});
