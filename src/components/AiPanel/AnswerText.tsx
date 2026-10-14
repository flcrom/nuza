import { memo, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isWebLink, parseAnswer, type Inline } from "@/lib/ai/answerMarkdown";
import { report } from "@/lib/notices";

function inline(nodes: Inline[]): ReactNode[] {
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
      case "strong":
        return <strong key={index}>{inline(node.children)}</strong>;
      case "em":
        return <em key={index}>{inline(node.children)}</em>;
      case "link":
        // A web address opens in the browser; anything else stays text.
        return isWebLink(node.href) ? (
          <button
            key={index}
            type="button"
            title={node.href}
            className="cursor-pointer text-[var(--nuza-accent)] underline-offset-2 hover:underline"
            onClick={() => void openUrl(node.href).catch((error) => report("Couldn't open that link", error))}
          >
            {inline(node.children)}
          </button>
        ) : (
          <span key={index}>{inline(node.children)}</span>
        );
    }
  });
}

/** An answer's words, drawn from its Markdown without ever becoming HTML. */
function AnswerText({ text }: { text: string }) {
  return (
    <div className="space-y-2 break-words">
      {parseAnswer(text).map((block, index) => {
        switch (block.type) {
          case "paragraph":
            return (
              <p key={index} className="whitespace-pre-wrap">
                {inline(block.children)}
              </p>
            );
          case "heading":
            return (
              <p key={index} className="font-semibold">
                {inline(block.children)}
              </p>
            );
          case "code":
            return (
              <pre
                key={index}
                className="overflow-x-auto rounded-md bg-zinc-900 p-2 font-mono text-[0.85em] leading-snug"
              >
                {block.text}
              </pre>
            );
          case "quote":
            return (
              <blockquote
                key={index}
                className="whitespace-pre-wrap border-l-2 border-zinc-700 pl-2 text-gray-400"
              >
                {inline(block.children)}
              </blockquote>
            );
          case "list": {
            const List = block.ordered ? "ol" : "ul";
            return (
              <List key={index} className={block.ordered ? "list-decimal pl-5" : "list-disc pl-5"}>
                {block.items.map((item, at) => (
                  <li key={at}>{inline(item)}</li>
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
