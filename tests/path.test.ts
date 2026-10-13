import { describe, expect, test } from "bun:test";
import { isWithin, rewritePath, samePath, withoutTrailingSeparator } from "../src/lib/path";

describe("isWithin", () => {
  test("a path is within itself", () => {
    expect(isWithin("/v/a.md", "/v/a.md")).toBe(true);
  });

  test("a descendant is within its ancestor, either separator", () => {
    expect(isWithin("/v/notes/a.md", "/v/notes")).toBe(true);
    expect(isWithin("C:\\v\\notes\\a.md", "C:\\v\\notes")).toBe(true);
  });

  test("a sibling that merely shares a prefix is not", () => {
    expect(isWithin("/v/notes-archive/a.md", "/v/notes")).toBe(false);
  });

  // A vault opened on a drive or on the POSIX root. The ancestor is its own
  // separator, so the old `ancestor + "/"` looked for `//` and `C:\\` and
  // never matched - nothing in such a vault counted as being inside it.
  describe("a vault at a root", () => {
    test("holds the notes directly in it", () => {
      expect(isWithin("/a.md", "/")).toBe(true);
      expect(isWithin("C:\\a.md", "C:\\")).toBe(true);
    });

    test("holds the notes in its folders", () => {
      expect(isWithin("/notes/a.md", "/")).toBe(true);
      expect(isWithin("C:\\notes\\a.md", "C:\\")).toBe(true);
    });

    test("is within itself, spelled either way", () => {
      expect(isWithin("/", "/")).toBe(true);
      expect(isWithin("C:\\", "C:\\")).toBe(true);
    });

    test("does not reach onto another drive", () => {
      expect(isWithin("D:\\a.md", "C:\\")).toBe(false);
    });
  });

  test("an ancestor of nothing contains nothing but itself", () => {
    expect(isWithin("/v/a.md", "")).toBe(false);
    expect(isWithin("", "")).toBe(true);
  });
});

describe("withoutTrailingSeparator", () => {
  test("takes the separator off a root and leaves every other path alone", () => {
    expect(withoutTrailingSeparator("/")).toBe("");
    expect(withoutTrailingSeparator("C:\\")).toBe("C:");
    expect(withoutTrailingSeparator("/v/notes")).toBe("/v/notes");
    expect(withoutTrailingSeparator("/v/notes/")).toBe("/v/notes");
  });
});

describe("samePath", () => {
  test("a root is the same place however it is spelled", () => {
    expect(samePath("C:\\", "C:")).toBe(true);
    expect(samePath("/", "")).toBe(true);
    expect(samePath("/v/notes", "/v/notes/")).toBe(true);
  });

  test("different places are not", () => {
    expect(samePath("/v/a", "/v/b")).toBe(false);
    expect(samePath("C:\\", "D:\\")).toBe(false);
  });
});

describe("rewritePath", () => {
  test("moves a renamed file", () => {
    expect(rewritePath("/v/a.md", "/v/a.md", "/v/b.md")).toBe("/v/b.md");
  });

  test("carries descendants along with a renamed folder", () => {
    expect(rewritePath("/v/notes/sub/x.md", "/v/notes", "/v/archive")).toBe("/v/archive/sub/x.md");
  });

  test("leaves unrelated paths alone", () => {
    expect(rewritePath("/other/z.md", "/v/a.md", "/v/b.md")).toBe("/other/z.md");
    expect(rewritePath("/v/notes-archive/x.md", "/v/notes", "/v/gone")).toBe("/v/notes-archive/x.md");
  });

  // The reason this module exists: String.replace reads these in its
  // replacement, so renaming a note to one of them used to rewrite every open
  // tab's path into nonsense.
  test.each([["/v/costs $' stuff.md"], ["/v/$& total.md"], ["/v/100$ and $1.md"], ["/v/$`x.md"]])(
    "treats %s as literal text",
    (to) => {
      expect(rewritePath("/v/a.md", "/v/a.md", to)).toBe(to);
    }
  );

  test("keeps dollar patterns literal for descendants too", () => {
    expect(rewritePath("/v/deep/n.md", "/v/deep", "/v/$`x")).toBe("/v/$`x/n.md");
  });

  test("supports Windows separators", () => {
    expect(rewritePath("C:\\v\\notes\\f.md", "C:\\v\\notes", "C:\\v\\$1")).toBe("C:\\v\\$1\\f.md");
  });

  // Not something the app can ask for - a vault root is not renamed from
  // inside it - but the prefix arithmetic should not invent a separator or
  // swallow one if it ever is.
  test("a root prefix keeps exactly one separator", () => {
    expect(rewritePath("/a.md", "/", "/moved")).toBe("/moved/a.md");
    expect(rewritePath("C:\\a.md", "C:\\", "D:\\")).toBe("D:\\a.md");
  });
});
