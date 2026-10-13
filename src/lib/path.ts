/**
 * A path without the separator a root carries and nothing else does.
 *
 * `/` and `C:\` are the only paths that end in one, and they are the two a
 * vault can be opened on while still being somebody's notes folder - a notes
 * drive on Windows above all. Everything below compares paths by prefix, and a
 * prefix that already ends in a separator does not want another one put on it.
 */
export function withoutTrailingSeparator(path: string) {
  return path.replace(/[/\\]+$/, "");
}

/** Whether two paths name the same place, whatever either does about a trailing separator. */
export function samePath(a: string, b: string) {
  return withoutTrailingSeparator(a) === withoutTrailingSeparator(b);
}

/**
 * True if `path` is `ancestor` itself, or lives somewhere underneath it.
 *
 * The trailing separator is why this is not a plain `startsWith(ancestor + "/")`.
 * A vault opened on `/` or on `C:\` is its own separator already, and comparing
 * against `//` or `C:\\` matched nothing - so with a drive open as the vault,
 * no note in it was ever "inside" it. That took the tab menu's items away, kept
 * new files out of the sidebar, and made `nuza D:\notes\a.md` re-root the whole
 * vault instead of selecting the tab.
 */
export function isWithin(path: string, ancestor: string) {
  // An ancestor of nothing contains nothing but itself. Trimmed, `/` is the
  // empty string, so this is asked of what was passed rather than of that.
  if (!ancestor) return path === ancestor;
  if (samePath(path, ancestor)) return true;

  const root = withoutTrailingSeparator(ancestor);
  return path.startsWith(root + "/") || path.startsWith(root + "\\");
}

/** Replaces an ancestor prefix literally, without interpreting `$` patterns. */
export function rewritePath(path: string, from: string, to: string) {
  if (!isWithin(path, from)) return path;
  // Sliced at the trimmed length, so a `from` that ends in a separator leaves
  // the separator on the rest rather than taking it with the prefix.
  const rest = path.slice(withoutTrailingSeparator(from).length);
  return withoutTrailingSeparator(to) + rest;
}
