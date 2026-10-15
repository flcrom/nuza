import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { StyleModule } from "style-mod";

// CodeMirror mounts its styles again every time the editor is handed another
// note's state. style-mod before 4.1.4 rewrote its whole <style> element each
// time, even with nothing new in it, and the browser then restyled every
// element on the page: a switch between notes took four times as long with a
// long AI chat open, and grew with everything else on screen.
test("mounting the same styles again leaves the stylesheet alone", async () => {
  const window = new Window();
  const document = window.document as unknown as Document;
  const editor = new StyleModule({ ".cm-editor": { color: "red" } });
  const theme = new StyleModule({ ".cm-scroller": { fontSize: "16px" } });

  StyleModule.mount(document, [editor, theme]);
  const sheet = document.head.querySelector("style");
  expect(sheet?.textContent).toContain(".cm-scroller");

  const changes: MutationRecord[] = [];
  const observer = new window.MutationObserver((records) =>
    changes.push(...(records as unknown as MutationRecord[]))
  );
  observer.observe(document.head as never, { childList: true, characterData: true, subtree: true });
  StyleModule.mount(document, [editor, theme]);
  StyleModule.mount(document, [editor, theme]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  observer.disconnect();

  expect(changes).toHaveLength(0);
});
