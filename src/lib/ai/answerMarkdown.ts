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
