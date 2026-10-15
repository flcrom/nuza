import { createContext, useContext } from "react";
import { FileEntry } from "@/lib/types";

export type PendingCreate = { parentPath: string; type: "file" | "folder" } | null;

export type ContextMenuState = {
  x: number;
  y: number;
  /** The entry that was right-clicked, or `null` for the background/root. */
  entry: FileEntry | null;
} | null;

/**
 * What a row in the tree can do. Everything here is stable for as long as the
 * sidebar is, or close to it - which is what lets the value be memoised and a
 * search keystroke stop re-rendering the whole vault. Anything that changes
 * per animation frame belongs in `dragSource`, not here.
 */
export interface TreeActions {
  onFileSelect?: (path: string) => void;
  currentFile: string;
  /** The row selected in the tree: where the header's New File and New Folder put things. */
  selectedPath: string | null;
  renamingPath: string | null;
  submitRename: (path: string, newName: string) => void;
  cancelRename: () => void;
  pendingCreate: PendingCreate;
  submitCreate: (name: string) => void;
  cancelCreate: () => void;
  openContextMenu: (e: React.MouseEvent, entry: FileEntry | null) => void;
  moveEntry: (path: string, targetDir: string) => void;
  /** Files dragged in from outside the app, to be copied into `directory`. */
  attachFiles: (directory: string, files: File[]) => void;
  /**
   * Reads what is inside a folder that has just been opened. Rejects when the
   * folder did not answer, so its row can say so.
   */
  loadFolder: (path: string) => Promise<void>;
}

export const TreeContext = createContext<TreeActions | null>(null);

export function useTreeContext() {
  const ctx = useContext(TreeContext);
  if (!ctx) throw new Error("useTreeContext must be used within a TreeContext.Provider");
  return ctx;
}
