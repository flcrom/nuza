import { fuzzyMatch } from "./fileSearch";

/** A setting that is either on or off, as the settings palette lists it. */
export interface ToggleSetting {
  id: string;
  title: string;
  description: string;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
}

export interface ToggleMatch<T> {
  setting: T;
  /** Indices in the title that the query matched, for highlighting. */
  highlight: number[];
}

/**
 * The settings that match `query`, best first - or all of them, in the order
 * given, when nothing has been typed. A hit on the title outranks one that is
 * only in the description, so "vim" finds Vim Mode and "gutter" still finds
 * Line Numbers.
 */
export function searchSettings<T extends { title: string; description: string }>(
  settings: T[],
  query: string
): ToggleMatch<T>[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return settings.map((setting) => ({ setting, highlight: [] }));

  const matches: (ToggleMatch<T> & { score: number })[] = [];

  for (const setting of settings) {
    const byTitle = fuzzyMatch(setting.title, needle);
    if (byTitle) {
      matches.push({ setting, highlight: byTitle.indices, score: byTitle.score + 25 });
      continue;
    }

    // The description is a sentence, where a loose subsequence would match
    // nearly anything - so there the words have to actually be in it.
    if (setting.description.toLowerCase().includes(needle)) {
      matches.push({ setting, highlight: [], score: 0 });
    }
  }

  return matches.sort((a, b) => b.score - a.score).map(({ setting, highlight }) => ({ setting, highlight }));
}
