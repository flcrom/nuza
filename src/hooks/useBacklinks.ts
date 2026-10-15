import { useMemo } from "react";
import { WikiLinkRef, backlinkIndex } from "@/lib/markdown/wikiLinks";
import { useVaultScan } from "./useVaultScan";

const NONE: WikiLinkRef[] = [];

/**
 * The wiki-links elsewhere in the vault that lead to `path`, from the links
 * the vault's notes hold (see `useVaultScan` for when they are read again).
 */
export function useBacklinks(path: string, root: string | null, notePaths: string[], enabled: boolean) {
  const { found: links, notes } = useVaultScan<WikiLinkRef>(
    "list_wiki_links",
    path,
    root,
    notePaths,
    enabled
  );

  // Worked out for the whole vault when what it links changes, and only looked
  // up when another note is opened - which is every tab switch.
  const byTarget = useMemo(
    () => (root ? backlinkIndex(links, notes ? notes.split("\n") : [], root) : null),
    [links, notes, root]
  );
  return useMemo(() => byTarget?.get(path) ?? NONE, [byTarget, path]);
}
