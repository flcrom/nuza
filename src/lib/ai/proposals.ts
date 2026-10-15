import { SELECTION_END, SELECTION_START } from "./markers";

/**
 * The edits an agent proposes, read out of its answer and checked against
 * the note before anyone sees them.
 *
 * An edit is anchored: `find` is text copied from the note, `replace` what
 * goes there instead. The anchor checks itself - either it is in the note
 * exactly once, or the edit is turned down before it is ever drawn - so an
 * edit cannot land somewhere it was not meant for, the way a line number
 * that has gone stale can. Nothing here is trusted to the model having read
 * its instructions: every rule it was told is enforced again here.
 */

/** The fence the edits come in. */
export const EDITS_FENCE = "nuza-edits";
/** At most this many edits in one answer. */
export const MAX_EDITS = 20;
/** And no anchor longer than this. */
export const MAX_FIND = 2000;

export interface Proposal {
  id: string;
  /** Where the anchor is in the note it was checked against. */
  from: number;
  to: number;
  find: string;
  replace: string;
  why: string;
}

/** An edit as it was written, before it was found in the note. */
export interface ProposedEdit {
  find: string;
  replace: string;
  why: string;
}

export type ParseFailure =
  | "no-block"
  | "malformed"
  | "too-many"
  | "too-long"
  | "anchor-missing"
  | "anchor-ambiguous"
  | "outside-selection"
  | "overlap";

export type ParseResult =
  | { ok: true; proposals: Proposal[] }
  | {
      ok: false;
      reason: ParseFailure;
      detail?: string;
      /** For a missing or ambiguous anchor: which edits (counted from 1) did not line up. */
      failed?: number[];
      /** The edits that did line up, when only some of them did. */
      resolved?: Proposal[];
    };

/** Where the last edits block is in an answer, if it has one. */
function lastBlock(answer: string): { start: number; body: string } | null {
  const opening = new RegExp("```" + EDITS_FENCE + "[ \\t]*\\r?\\n", "g");
  let match: RegExpExecArray | null;
  let last: RegExpExecArray | null = null;
  while ((match = opening.exec(answer))) last = match;
  if (!last) return null;
  // The last fence, not the first: a model that explains the format before
  // using it should not have its explanation read as the edits. And the
  // block runs to the last closing fence, so one inside a JSON string -
  // an edit to a code block - does not cut it short.
  const bodyStart = last.index + last[0].length;
  const close = answer.lastIndexOf("```");
  const body = close >= bodyStart ? answer.slice(bodyStart, close) : answer.slice(bodyStart);
  return { start: last.index, body };
}

/** The answer's words, without the edits block - the edits are drawn as cards instead. */
export function proseOf(answer: string): string {
  const block = lastBlock(answer);
  return block ? answer.slice(0, block.start).trimEnd() : answer;
}

/** Whether an answer has started an edits block, which it may still be writing. */
export function hasEditsBlock(answer: string): boolean {
  return lastBlock(answer) !== null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // The one repair: the trailing comma models leave after the last edit.
    return JSON.parse(text.replace(/,(\s*[\]}])/g, "$1"));
  }
}

/** The marks nuza put around the selection are not part of the note. */
function unmarked(text: string): string {
  return text.split(SELECTION_START).join("").split(SELECTION_END).join("");
}

/** The edits in an answer, as written, checked for shape and size but not yet against a note. */
export function editsIn(
  answer: string
): { ok: true; edits: ProposedEdit[] } | Extract<ParseResult, { ok: false }> {
  const block = lastBlock(answer);
  if (!block) return { ok: false, reason: "no-block" };

  let parsed: unknown;
  try {
    parsed = parseJson(block.body.trim());
  } catch (error) {
    return { ok: false, reason: "malformed", detail: error instanceof Error ? error.message : String(error) };
  }
  if (!Array.isArray(parsed)) return { ok: false, reason: "malformed", detail: "not a list of edits" };
  if (parsed.length > MAX_EDITS) return { ok: false, reason: "too-many", detail: `${parsed.length} edits` };

  const edits: ProposedEdit[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) return { ok: false, reason: "malformed" };
    const { find, replace, why } = entry as Record<string, unknown>;
    if (typeof find !== "string" || typeof replace !== "string") {
      return { ok: false, reason: "malformed", detail: "an edit without find and replace" };
    }
    const anchor = unmarked(find);
    if (!anchor) return { ok: false, reason: "malformed", detail: "an empty find" };
    if (anchor.length > MAX_FIND)
      return { ok: false, reason: "too-long", detail: `${anchor.length} characters` };
    edits.push({ find: anchor, replace: unmarked(replace), why: typeof why === "string" ? why.trim() : "" });
  }
  return { ok: true, edits };
}

/** A range of the note a change was asked for - what the writer selected. */
export interface Scope {
  from: number;
  to: number;
}

/**
 * Where `find` is in `note`: once, nowhere, or more than once. With a
 * `scope`, only where it touches the scope counts - so the selected word is
 * the one changed, however often it appears elsewhere - and text found only
 * outside it is said to be.
 */
function locate(
  note: string,
  find: string,
  scope?: Scope | null
): number | "missing" | "ambiguous" | "outside" {
  const all: number[] = [];
  for (let at = note.indexOf(find); at !== -1; at = note.indexOf(find, at + 1)) all.push(at);
  if (!all.length) return "missing";
  if (!scope) return all.length === 1 ? all[0] : "ambiguous";
  const inside = all.filter((at) => at < scope.to && at + find.length > scope.from);
  if (!inside.length) return "outside";
  return inside.length === 1 ? inside[0] : "ambiguous";
}

let nextId = 0;

/**
 * Finds each edit in `note`, and checks the set does not overlap. With a
 * `scope`, every edit must be inside it.
 */
export function resolveEdits(edits: ProposedEdit[], note: string, scope?: Scope | null): ParseResult {
  const resolved: Proposal[] = [];
  const missing: number[] = [];
  const ambiguous: number[] = [];
  const outside: number[] = [];
  edits.forEach((edit, index) => {
    const at = locate(note, edit.find, scope);
    if (at === "missing") missing.push(index + 1);
    else if (at === "ambiguous") ambiguous.push(index + 1);
    else if (at === "outside") outside.push(index + 1);
    else resolved.push({ id: `edit-${++nextId}`, from: at, to: at + edit.find.length, ...edit });
  });

  if (missing.length || ambiguous.length || outside.length) {
    return {
      ok: false,
      reason: outside.length ? "outside-selection" : missing.length ? "anchor-missing" : "anchor-ambiguous",
      failed: [...missing, ...ambiguous, ...outside].sort((a, b) => a - b),
      resolved,
    };
  }

  resolved.sort((a, b) => a.from - b.from);
  for (let i = 1; i < resolved.length; i++) {
    if (resolved[i].from < resolved[i - 1].to) return { ok: false, reason: "overlap" };
  }
  return { ok: true, proposals: resolved };
}

/** The edits an answer proposes, found in `note` - the note as it was sent. */
export function parseProposals(answer: string, note: string, scope?: Scope | null): ParseResult {
  const read = editsIn(answer);
  return read.ok ? resolveEdits(read.edits, note, scope) : read;
}

/**
 * The proposals found again in the note as it is now. The person may have
 * typed while the agent was thinking: an edit whose anchor no longer appears
 * exactly once is set aside rather than put somewhere it may no longer mean.
 */
export function againstLiveNote(
  proposals: Proposal[],
  live: string,
  scope?: Scope | null
): { fresh: Proposal[]; stale: Proposal[] } {
  const fresh: Proposal[] = [];
  const stale: Proposal[] = [];
  for (const proposal of proposals) {
    const at = locate(live, proposal.find, scope);
    if (typeof at === "number") fresh.push({ ...proposal, from: at, to: at + proposal.find.length });
    else stale.push(proposal);
  }
  return { fresh, stale };
}

/**
 * The one follow-up sent when some anchors did not line up: which edits,
 * and what to do about them.
 */
export function retryRequest(failed: number[], scoped = false): string {
  const which =
    failed.length === 1
      ? `Edit ${failed[0]}`
      : `Edits ${failed.slice(0, -1).join(", ")} and ${failed[failed.length - 1]}`;
  if (scoped)
    return (
      `${which} could not be applied: the writer asked for a change to the selected text only, and every \`find\` ` +
      `must be copied character-for-character from inside the selection marks. Re-send only the edits that failed, ` +
      `in a new \`${EDITS_FENCE}\` block, changing nothing outside the selection. Say nothing else.`
    );
  return (
    `${which} could not be applied: the text you asked to find does not appear in the note exactly once. ` +
    `Re-send only the edits that failed, in a new \`${EDITS_FENCE}\` block, with longer \`find\` anchors ` +
    "copied character-for-character from the note. Say nothing else."
  );
}

/**
 * The edits to show after the one retry: those that lined up the first time,
 * and those the retry fixed - less any that would now overlap. `unplaced` is
 * how many of the failed ones still did not line up, for the panel to say.
 */
export function afterRetry(
  lined: Proposal[],
  failedCount: number,
  retryAnswer: string,
  note: string,
  scope?: Scope | null
): { proposals: Proposal[]; unplaced: number } {
  const read = editsIn(retryAnswer);
  let fixed: Proposal[] = [];
  if (read.ok) {
    const resolved = resolveEdits(read.edits, note, scope);
    fixed = resolved.ok ? resolved.proposals : (resolved.resolved ?? []);
  }
  const kept: Proposal[] = [];
  for (const proposal of [...lined, ...fixed].sort((a, b) => a.from - b.from)) {
    const last = kept[kept.length - 1];
    if (!last || proposal.from >= last.to) kept.push(proposal);
  }
  return { proposals: kept, unplaced: Math.max(0, failedCount - (kept.length - lined.length)) };
}
