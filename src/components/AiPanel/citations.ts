import { createContext } from "react";

/** What an answer's `nuza:` citations may open, and how. */
export interface Citations {
  /** Notes the agent was shown - the only ones a citation links to. */
  citable: ReadonlySet<string>;
  open: (path: string, paragraph: number | null) => void;
}

export const CitationContext = createContext<Citations | null>(null);
