import { describe, expect, test } from "bun:test";
import { GFM, parser } from "@lezer/markdown";
import {
  WikiLink,
  backlinksTo,
  readWikiLink,
  resolveWikiLink,
  wikiLinkText,
  wikiTargetFor,
} from "../src/lib/markdown/wikiLinks";

const markdown = parser.configure([GFM, WikiLink]);

/** The source of every wiki-link the parser finds in `text`. */
function links(text: string) {
  const found: string[] = [];
  markdown.parse(text).iterate({
    enter: (node) => {
      if (node.name === "WikiLink") found.push(text.slice(node.from, node.to));
    },
  });
  return found;
}

describe("the WikiLink parser", () => {
  test("finds a link by name, by path, and with a label", () => {
    expect(links("see [[Ideas]], [[notes/todo]] and [[Ideas|my ideas]].")).toEqual([
      "[[Ideas]]",
      "[[notes/todo]]",
      "[[Ideas|my ideas]]",
    ]);
  });

  test("leaves ordinary links alone", () => {
    expect(links("a [link](https://x.y) and [ref]")).toEqual([]);
  });

  test("needs something between the brackets, and both closing brackets", () => {
    expect(links("[[]] and [[open] and [[a\nb]]")).toEqual([]);
  });

  test("does not look inside code", () => {
    expect(links("`[[not a link]]`")).toEqual([]);
  });
});

describe("readWikiLink", () => {
  test("splits the target, heading and label", () => {
    expect(readWikiLink("Ideas#Later|some ideas")).toEqual({
      target: "Ideas",
      heading: "Later",
      label: "some ideas",
    });
    expect(readWikiLink(" Ideas ")).toEqual({ target: "Ideas", heading: null, label: null });
  });
});

describe("resolveWikiLink", () => {
  const root = "/vault";
  const notes = ["/vault/Ideas.md", "/vault/work/ideas.md", "/vault/work/deep/todo.md", "/vault/todo.md"];

  test("matches a name regardless of case and .md", () => {
    expect(resolveWikiLink("TODO.md", ["/vault/work/deep/todo.md"], root, "/vault")).toBe(
      "/vault/work/deep/todo.md"
    );
  });

  test("prefers the note beside the linking one, then the one nearest the root", () => {
    expect(resolveWikiLink("ideas", notes, root, "/vault/work")).toBe("/vault/work/ideas.md");
    expect(resolveWikiLink("ideas", notes, root, "/vault/elsewhere")).toBe("/vault/Ideas.md");
    expect(resolveWikiLink("todo", notes, root, "/vault/work")).toBe("/vault/todo.md");
  });

  test("matches a path from the vault's root exactly", () => {
    expect(resolveWikiLink("work/deep/todo", notes, root, "/vault")).toBe("/vault/work/deep/todo.md");
    expect(resolveWikiLink("deep/todo", notes, root, "/vault")).toBeNull();
  });

  test("works with Windows paths", () => {
    expect(resolveWikiLink("work/ideas", ["C:\\vault\\work\\ideas.md"], "C:\\vault", "C:\\vault")).toBe(
      "C:\\vault\\work\\ideas.md"
    );
  });

  test("finds nothing for a note that is not there", () => {
    expect(resolveWikiLink("missing", notes, root, "/vault")).toBeNull();
    expect(resolveWikiLink("  ", notes, root, "/vault")).toBeNull();
  });
});

describe("backlinksTo", () => {
  const root = "/vault";
  const notes = ["/vault/Ideas.md", "/vault/work/ideas.md", "/vault/a.md", "/vault/work/b.md"];
  const link = (from: string, target: string, line = 1) => ({ from, target, line, preview: "" });

  test("finds the links that resolve to the note, labels and headings included", () => {
    const links = [
      link("/vault/a.md", "Ideas|my ideas", 3),
      link("/vault/a.md", "ideas#Later", 1),
      link("/vault/work/b.md", "ideas"),
      link("/vault/a.md", "missing"),
    ];
    const found = backlinksTo("/vault/Ideas.md", links, notes, root);
    expect(found.map((l) => `${l.from}:${l.line}`)).toEqual(["/vault/a.md:1", "/vault/a.md:3"]);
  });

  test("resolves from the linking note's folder", () => {
    const found = backlinksTo("/vault/work/ideas.md", [link("/vault/work/b.md", "ideas")], notes, root);
    expect(found).toHaveLength(1);
  });

  test("leaves out a note's links to itself", () => {
    expect(backlinksTo("/vault/a.md", [link("/vault/a.md", "a")], notes, root)).toEqual([]);
  });
});

describe("wikiTargetFor", () => {
  const root = "/vault";
  const notes = ["/vault/Ideas.md", "/vault/work/ideas.md", "/vault/todo.md"];

  test("writes the name where the name finds the note", () => {
    expect(wikiTargetFor("/vault/todo.md", notes, root, "/vault")).toBe("todo");
    expect(wikiTargetFor("/vault/work/ideas.md", notes, root, "/vault/work")).toBe("ideas");
  });

  test("writes the path where another note of that name would win", () => {
    expect(wikiTargetFor("/vault/work/ideas.md", notes, root, "/vault")).toBe("work/ideas");
  });
});

describe("wikiLinkText", () => {
  test("uses the selection as the label", () => {
    expect(wikiLinkText("todo", "my list")).toBe("[[todo|my list]]");
  });

  test("leaves the label out when there is none, or it is the target", () => {
    expect(wikiLinkText("todo", "")).toBe("[[todo]]");
    expect(wikiLinkText("todo", "todo")).toBe("[[todo]]");
  });

  test("keeps a label to one line and free of brackets and bars", () => {
    expect(wikiLinkText("todo", "a [b]\n c|d")).toBe("[[todo|a b cd]]");
  });
});

describe("links looked up in an index of the vault", () => {
  // The way links were resolved before the index: every note, every time.
  function slowly(target: string, notes: string[], root: string, fromDirectory: string) {
    const comparable = (path: string) =>
      (path.startsWith(root) ? path.slice(root.length) : path)
        .replace(/\\/g, "/")
        .replace(/^\/+/, "")
        .replace(/\.md$/i, "")
        .toLowerCase();
    const folderOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")));
    const wanted = target.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\.md$/i, "").toLowerCase();
    if (!wanted) return null;
    const byPath = wanted.includes("/");
    const matches = notes.filter((note) => {
      const path = comparable(note);
      return byPath ? path === wanted : path.slice(path.lastIndexOf("/") + 1) === wanted;
    });
    if (matches.length <= 1) return matches[0] ?? null;
    const depth = (note: string) => comparable(note).split("/").length;
    return matches.slice().sort((a, b) => {
      const besideA = folderOf(a) === fromDirectory ? 0 : 1;
      const besideB = folderOf(b) === fromDirectory ? 0 : 1;
      return besideA - besideB || depth(a) - depth(b) || a.localeCompare(b);
    })[0];
  }

  const root = "/v";
  const folders = ["", "/a", "/a/b", "/c", "/C"];
  const names = ["Plan", "plan", "Ideas", "notes", "Zebra", "Plan.MD"];
  const notes = folders.flatMap((folder) =>
    names.map((name) => `${root}${folder}/${name}${name.endsWith(".MD") ? "" : ".md"}`)
  );
  const targets = [
    "Plan",
    "plan.md",
    "PLAN",
    "a/Plan",
    "/a/b/plan",
    "c/ideas",
    "C/Ideas.md",
    "missing",
    "",
    "  zebra  ",
    "a\\b\\Notes",
  ];

  test("finds the same note as going through every note did", () => {
    for (const target of targets)
      for (const folder of folders)
        expect(resolveWikiLink(target, notes, root, `${root}${folder}`)).toBe(
          slowly(target, notes, root, `${root}${folder}`)
        );
  });

  test("gives each note the same backlinks, in the same order", () => {
    const links = notes.flatMap((from, n) =>
      targets.map((target, line) => ({ from, target, line: line + n }))
    );
    for (const note of notes) {
      const expected = links
        .filter(
          (link) =>
            link.from !== note &&
            slowly(link.target, notes, root, link.from.slice(0, link.from.lastIndexOf("/"))) === note
        )
        .sort((a, b) => a.from.localeCompare(b.from) || a.line - b.line);
      expect(backlinksTo(note, links, notes, root)).toEqual(expected);
    }
  });
});
