/**
 * The Markdown of an agent's answer, as a small tree the panel draws with
 * React elements.
 *
 * Model output is the least trusted text in the app, so it never becomes
 * HTML: there is no `innerHTML` anywhere on this path, and a link is only
 * ever a button that asks the system to open an http(s) address. Enough of
 * Markdown is understood for an answer to read well - paragraphs, headings,
 * lists, quotes, code, emphasis, links - and the rest is shown as the text
 * it is.
 */

import { SELECTION_END, SELECTION_START } from "./markers";
import { FRAMING_PHRASES, HARNESS_PHRASES } from "./prompt";

/** nuza's delimiter around the note, which is never part of an answer. */
const NOTE_TAG = /<\/?note id="[^"\n]*">/g;

/**
 * An answer as it is shown: without the note's delimiter tags, the
 * selection marks, or any line that recites nuza's own framing. What the
 * agent was told stays between nuza and the agent.
 */
/**
 * An answer without the reasoning some models write into it, marked with
 * think tags: a whole `<think>...</think>`, everything before a closing tag
 * that was never opened (the model began by thinking), and an opened one
 * still streaming.
 */
export function withoutThinking(answer: string): string {
  let text = answer.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const close = text.toLowerCase().lastIndexOf("</think>");
  if (close !== -1) text = text.slice(close + "</think>".length);
  const open = text.toLowerCase().indexOf("<think>");
  if (open !== -1) text = text.slice(0, open);
  return text.replace(/^\s+/, "");
}

export function forDisplay(answer: string): string {
  const cleaned = withoutThinking(answer)
    .replace(NOTE_TAG, "")
    .split(SELECTION_START)
    .join("")
    .split(SELECTION_END)
    .join("");
  return cleaned
    .split("\n")
    .filter((line) => ![...FRAMING_PHRASES, ...HARNESS_PHRASES].some((phrase) => line.includes(phrase)))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

export type Inline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "link"; href: string; children: Inline[] };

export type Block =
  | { type: "paragraph"; children: Inline[] }
  | { type: "heading"; level: number; children: Inline[] }
  | { type: "code"; language: string; text: string }
  | { type: "quote"; children: Inline[] }
  | { type: "list"; ordered: boolean; items: Inline[][] };

/**
 * A citation of a note: `nuza:projects/release.md#12` is paragraph 12 of
 * that note. Whether it opens anything is decided elsewhere - only notes the
 * agent was actually shown do.
 */
export function parseCitation(href: string): { path: string; paragraph: number | null } | null {
  const match = /^nuza:([^#]+?)(?:#(\d+))?$/.exec(href.trim());
  if (!match) return null;
  let path: string;
  try {
    path = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  if (!path || path.startsWith("/") || path.split("/").includes("..")) return null;
  return { path, paragraph: match[2] ? Number(match[2]) : null };
}

/** Whether an address is one the panel will open: the web, nothing else. */
export function isWebLink(href: string): boolean {
  return /^https?:\/\//i.test(href.trim());
}

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let plain = "";
  const flush = () => {
    if (plain) out.push({ type: "text", text: plain });
    plain = "";
  };
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    let match: RegExpExecArray | null;
    if ((match = /^`([^`\n]+)`/.exec(rest))) {
      flush();
      out.push({ type: "code", text: match[1] });
    } else if (
      (match = /^\*\*(?=\S)([\s\S]*?\S)\*\*/.exec(rest)) ||
      (match = /^__(?=\S)([\s\S]*?\S)__/.exec(rest))
    ) {
      flush();
      out.push({ type: "strong", children: parseInline(match[1]) });
    } else if (
      (match = /^\*(?=[^\s*])([^*\n]*?[^\s*])\*/.exec(rest)) ||
      (match = /^_(?=\S)([^_\n]*?\S)_(?!\w)/.exec(rest))
    ) {
      flush();
      out.push({ type: "em", children: parseInline(match[1]) });
    } else if ((match = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(rest))) {
      flush();
      out.push({ type: "link", href: match[2], children: parseInline(match[1]) });
    } else {
      plain += text[i];
      i += 1;
      continue;
    }
    i += match[0].length;
  }
  flush();
  return out;
}

export function parseAnswer(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const endParagraph = () => {
    if (paragraph.length) blocks.push({ type: "paragraph", children: parseInline(paragraph.join("\n")) });
    paragraph = [];
  };

  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    const fence = /^\s{0,3}(`{3,}|~{3,})\s*([\w+-]*)/.exec(line);
    if (fence) {
      endParagraph();
      const body: string[] = [];
      n += 1;
      while (n < lines.length && !lines[n].trimStart().startsWith(fence[1])) body.push(lines[n++]);
      blocks.push({ type: "code", language: fence[2], text: body.join("\n") });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      endParagraph();
      blocks.push({ type: "heading", level: heading[1].length, children: parseInline(heading[2].trim()) });
      continue;
    }
    const item = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (item) {
      endParagraph();
      const ordered = item[2] !== undefined;
      const last = blocks[blocks.length - 1];
      if (last?.type === "list" && last.ordered === ordered && lines[n - 1]?.trim() !== "") {
        last.items.push(parseInline(item[3]));
      } else {
        blocks.push({ type: "list", ordered, items: [parseInline(item[3])] });
      }
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      endParagraph();
      const last = blocks[blocks.length - 1];
      if (last?.type === "quote") last.children.push({ type: "text", text: "\n" }, ...parseInline(quote[1]));
      else blocks.push({ type: "quote", children: parseInline(quote[1]) });
      continue;
    }
    if (line.trim() === "") {
      endParagraph();
      continue;
    }
    paragraph.push(line);
  }
  endParagraph();
  return blocks;
}
