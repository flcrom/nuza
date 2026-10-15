/**
 * What leaves nuza when a question is asked. This is the only place that
 * decides it.
 *
 * Four choices, each deliberate:
 *
 * - **The filename, never the path.** `~/vaults/acquisition-of-northwind/notes.md`
 *   tells the agent things nobody meant to tell it; `notes.md` does not.
 * - **Offsets, not a copy of the selection.** The selection is already in the
 *   note. Sending it twice doubles a long selection and invites the model to
 *   treat the two as different texts.
 * - **Trimmed by structure, never truncated.** Past the budget, the note keeps
 *   its frontmatter, every heading, and the section being asked about with its
 *   neighbours, and marks each gap with how many lines went - rather than
 *   silently losing its end and having the model reason about a note it cannot
 *   see.
 * - **The live buffer**, unsaved edits and all: the question is about what is
 *   on the screen.
 */

/** The most note text one question sends: about 12,000 tokens. */
export const NOTE_BUDGET = 48_000;

export interface AiContext {
  /** The note's filename. */
  title: string;
  /** The note as it is sent: whole, trimmed, only the selection, or nothing. */
  note: string;
  /** Where the selection is in `note`, if there is one. */
  selection: { from: number; to: number } | null;
  /** Whether `note` is less than the whole note. */
  trimmed: boolean;
  /** How many of the note's lines were left out. */
  omittedLines: number;
  /** Whether only the selection is sent, because the whole note is turned off. */
  selectionOnly: boolean;
}

export interface ContextInput {
  /** The note's path, or anything that ends in its name. */
  path: string;
  /** The note's text as it stands in the editor. */
  text: string;
  /** The selection, or the caret when `from === to`. */
  selection: { from: number; to: number };
  /** Whether the whole note may be sent, or only what is selected. */
  wholeNote: boolean;
  budget?: number;
}

export type ContextResult = { ok: true; context: AiContext } | { ok: false; reason: "too-long" };

/** The last part of a path, whichever separator it uses. */
export function fileName(path: string): string {
  const name = path.split(/[\\/]/).filter(Boolean).pop();
  return name || "Untitled";
}

interface Section {
  from: number;
  to: number;
  /** The heading line that opens it, with its line break, if it has one. */
  heading: string | null;
  frontmatter: boolean;
}

/** Where each line starts. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

/**
 * The note cut into sections: the frontmatter, whatever comes before the
 * first heading, and each heading with what follows it up to the next. A `#`
 * inside a fenced code block is code, not a heading.
 */
export function sectionsOf(text: string): Section[] {
  const starts = lineStarts(text);
  const lineAt = (n: number) => text.slice(starts[n], n + 1 < starts.length ? starts[n + 1] : text.length);
  const sections: Section[] = [];
  let line = 0;

  if (/^---\r?\n/.test(text)) {
    for (let n = 1; n < starts.length; n++) {
      if (/^(---|\.\.\.)\s*$/.test(lineAt(n).replace(/\r?\n$/, ""))) {
        const to = n + 1 < starts.length ? starts[n + 1] : text.length;
        sections.push({ from: 0, to, heading: null, frontmatter: true });
        line = n + 1;
        break;
      }
    }
  }

  let fence: string | null = null;
  let current: Section | null = null;
  for (let n = line; n < starts.length; n++) {
    const content = lineAt(n);
    const fenceMark = /^\s{0,3}(`{3,}|~{3,})/.exec(content);
    if (fenceMark) {
      if (fence === null) fence = fenceMark[1][0];
      else if (fenceMark[1][0] === fence) fence = null;
    }
    const isHeading = fence === null && !fenceMark && /^#{1,6}(\s|$)/.test(content);
    if (isHeading || current === null) {
      if (current) {
        current.to = starts[n];
        sections.push(current);
      }
      current = { from: starts[n], to: text.length, heading: isHeading ? content : null, frontmatter: false };
    }
  }
  if (current) sections.push(current);
  return sections.filter((section) => section.to > section.from || section.frontmatter);
}

function linesIn(text: string): number {
  if (!text) return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

function gap(lines: number): string {
  return `[… ${lines} line${lines === 1 ? "" : "s"} omitted …]\n`;
}

/** What one question about the note sends. */
export function buildContext({
  path,
  text,
  selection,
  wholeNote,
  budget = NOTE_BUDGET,
}: ContextInput): ContextResult {
  const title = fileName(path);
  const from = Math.max(0, Math.min(selection.from, selection.to, text.length));
  const to = Math.min(text.length, Math.max(selection.from, selection.to));
  const selected = to > from;

  if (!wholeNote) {
    const only = text.slice(from, to);
    if (only.length > budget) return { ok: false, reason: "too-long" };
    return {
      ok: true,
      context: {
        title,
        note: only,
        selection: selected ? { from: 0, to: only.length } : null,
        trimmed: true,
        omittedLines: Math.max(0, linesIn(text) - linesIn(only)),
        selectionOnly: true,
      },
    };
  }

  if (text.length <= budget) {
    return {
      ok: true,
      context: {
        title,
        note: text,
        selection: selected ? { from, to } : null,
        trimmed: false,
        omittedLines: 0,
        selectionOnly: false,
      },
    };
  }

  const sections = sectionsOf(text);
  const touches = (section: Section) =>
    selected ? section.from < to && section.to > from : section.from <= from && from < section.to;
  let focus = sections.map((section, index) => (touches(section) ? index : -1)).filter((index) => index >= 0);
  if (focus.length === 0) focus = [sections.length - 1];

  const keep = new Set<number>();
  sections.forEach((section, index) => section.frontmatter && keep.add(index));
  const first = Math.max(0, focus[0] - 1);
  const last = Math.min(sections.length - 1, focus[focus.length - 1] + 1);
  for (let index = first; index <= last; index++) keep.add(index);

  /** What the note comes to with `kept` in full and the rest as headings and gaps. */
  const sizeWith = (kept: Set<number>) =>
    sections.reduce((size, section, index) => {
      if (kept.has(index)) return size + (section.to - section.from);
      const body = text.slice(section.from + (section.heading?.length ?? 0), section.to);
      return size + (section.heading?.length ?? 0) + (linesIn(body) ? gap(linesIn(body)).length : 0);
    }, 0);

  // The selection itself must fit; its neighbours are let go of first.
  if (sizeWith(keep) > budget) {
    for (const index of [first, last]) {
      if (!focus.includes(index) && !sections[index].frontmatter) keep.delete(index);
    }
    if (sizeWith(keep) > budget) return { ok: false, reason: "too-long" };
  }

  // Then outward from the selection, nearest first, while there is room.
  for (let distance = 1; distance < sections.length; distance++) {
    for (const index of [first - distance, last + distance]) {
      if (index < 0 || index >= sections.length || keep.has(index)) continue;
      keep.add(index);
      if (sizeWith(keep) > budget) keep.delete(index);
    }
  }

  let note = "";
  let omittedLines = 0;
  let shift: number | null = null;
  sections.forEach((section, index) => {
    if (keep.has(index)) {
      if (shift === null && section.from <= from && from <= section.to) shift = note.length - section.from;
      note += text.slice(section.from, section.to);
      return;
    }
    const heading = section.heading ?? "";
    const body = text.slice(section.from + heading.length, section.to);
    const lines = linesIn(body);
    omittedLines += lines;
    note += heading;
    if (heading && !heading.endsWith("\n")) note += "\n";
    if (lines) note += gap(lines);
  });

  const offset = shift ?? 0;
  return {
    ok: true,
    context: {
      title,
      note,
      selection: selected ? { from: from + offset, to: to + offset } : null,
      trimmed: true,
      omittedLines,
      selectionOnly: false,
    },
  };
}

/** The lines a selection covers, counted from one, for the context chip. */
export function selectionLines(text: string, selection: { from: number; to: number }): [number, number] {
  const before = (offset: number) => text.slice(0, offset).split("\n").length;
  const end =
    selection.to > selection.from && text[selection.to - 1] === "\n" ? selection.to - 1 : selection.to;
  return [before(selection.from), before(end)];
}
