import { memo, useContext, useState, type ReactNode } from "react";
import { Check, Copy, FileText } from "lucide-react";
import { copyText } from "@/lib/clipboard";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isWebLink, parseAnswer, parseCitation, type Inline } from "@/lib/ai/answerMarkdown";
import { CitationContext, type Citations } from "./citations";
import { report } from "@/lib/notices";

function inline(nodes: Inline[], citations: Citations | null): ReactNode[] {
  return nodes.map((node, index) => {
    switch (node.type) {
      case "text":
        return node.text;
      case "code":
        return (
          <code key={index} className="rounded bg-zinc-800 px-1 py-px font-mono text-[0.85em]">
            {node.text}
          </code>
        );
      case "math":
        // TeX as it was written: drawing it would mean HTML from the agent.
        return (
          <code
            key={index}
            title="TeX"
            className="rounded bg-zinc-800/70 px-1 py-px font-mono text-[0.85em] italic"
          >
            {node.text}
          </code>
        );
      case "strong":
        return <strong key={index}>{inline(node.children, citations)}</strong>;
      case "em":
        return <em key={index}>{inline(node.children, citations)}</em>;
      case "link": {
        // A note the agent was shown opens at the paragraph it cited; one it
        // was not - a citation it made up - stays text.
        const cited = parseCitation(node.href);
        if (cited) {
          return citations?.citable.has(cited.path) ? (
            <button
              key={index}
              type="button"
              title={cited.paragraph ? `${cited.path}, paragraph ${cited.paragraph}` : cited.path}
              className="inline-flex cursor-pointer items-baseline gap-0.5 text-[var(--nuza-accent)] underline-offset-2 hover:underline"
              onClick={() => citations.open(cited.path, cited.paragraph)}
            >
              <FileText size={11} className="self-center" aria-hidden />
              {inline(node.children, citations)}
            </button>
          ) : (
            <span key={index}>{inline(node.children, citations)}</span>
          );
        }
        // A web address opens in the browser; anything else stays text.
        return isWebLink(node.href) ? (
          <button
            key={index}
            type="button"
            title={node.href}
            className="cursor-pointer text-[var(--nuza-accent)] underline-offset-2 hover:underline"
            onClick={() => void openUrl(node.href).catch((error) => report("Couldn't open that link", error))}
          >
            {inline(node.children, citations)}
          </button>
        ) : (
          <span key={index}>{inline(node.children, citations)}</span>
        );
      }
    }
  });
}

/** A block of code in an answer, with what language it is and a way to copy it. */
function CodeBlock({ language, text }: { language: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    void copyText(text)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      })
      .catch((error) => report("Couldn't copy that", error));
  return (
    <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/80">
      <div className="flex items-center justify-between border-b border-zinc-800 px-2.5 py-1 text-[11px] text-gray-500">
        <span>{language || "text"}</span>
        <button
          type="button"
          onClick={copy}
          title="Copy"
          aria-label="Copy the code"
          className="cursor-pointer rounded p-0.5 hover:bg-zinc-800 hover:text-gray-200"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
      </div>
      <pre className="overflow-x-auto p-2.5 font-mono text-[0.85em] leading-snug">{text}</pre>
    </div>
  );
}

/** An answer's words, drawn from its Markdown without ever becoming HTML. */
function AnswerText({ text }: { text: string }) {
  const citations = useContext(CitationContext);
  return (
    <div className="space-y-2 break-words">
      {parseAnswer(text).map((block, index) => {
        switch (block.type) {
          case "paragraph":
            return (
              <p key={index} className="whitespace-pre-wrap">
                {inline(block.children, citations)}
              </p>
            );
          case "heading":
            return (
              <p key={index} className="font-semibold">
                {inline(block.children, citations)}
              </p>
            );
          case "code":
            return <CodeBlock key={index} language={block.language} text={block.text} />;
          case "table":
            return (
              <div key={index} className="overflow-x-auto">
                <table className="w-full border-collapse text-[0.92em]">
                  <thead>
                    <tr>
                      {block.header.map((cell, column) => (
                        <th
                          key={column}
                          style={{ textAlign: block.align[column] ?? "left" }}
                          className="border border-zinc-800 bg-zinc-900/70 px-2 py-1 font-medium text-gray-200"
                        >
                          {inline(cell, citations)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, line) => (
                      <tr key={line}>
                        {row.map((cell, column) => (
                          <td
                            key={column}
                            style={{ textAlign: block.align[column] ?? "left" }}
                            className="border border-zinc-800 px-2 py-1 align-top"
                          >
                            {inline(cell, citations)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "quote":
            return (
              <blockquote
                key={index}
                className="whitespace-pre-wrap border-l-2 border-zinc-700 pl-2 text-gray-400"
              >
                {inline(block.children, citations)}
              </blockquote>
            );
          case "list": {
            const List = block.ordered ? "ol" : "ul";
            return (
              <List key={index} className={block.ordered ? "list-decimal pl-5" : "list-disc pl-5"}>
                {block.items.map((item, at) => (
                  <li key={at}>{inline(item, citations)}</li>
                ))}
              </List>
            );
          }
        }
      })}
    </div>
  );
}

export default memo(AnswerText);
