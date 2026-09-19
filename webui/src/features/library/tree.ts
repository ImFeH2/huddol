import type { LibraryEntry } from "@/lib/backend";
import { documentFolder, documentName } from "@/lib/format";

export type TreeNode = LibraryEntry & {
  children: TreeNode[];
  fileCount: number;
};

export function buildTree(entries: LibraryEntry[]): TreeNode[] {
  const nodes = new Map(
    entries.map((entry) => [
      entry.path,
      { ...entry, children: [], fileCount: 0 } as TreeNode,
    ]),
  );
  const roots: TreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = nodes.get(documentFolder(node.path) ?? "");
    if (parent?.kind === "directory") parent.children.push(node);
    else roots.push(node);
  }
  const sort = (siblings: TreeNode[]) => {
    siblings.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
      return documentName(a.path).localeCompare(documentName(b.path), "en-US", {
        sensitivity: "base",
      });
    });
    for (const node of siblings) {
      sort(node.children);
      node.fileCount =
        node.kind === "file"
          ? 1
          : node.children.reduce((count, child) => count + child.fileCount, 0);
    }
  };
  sort(roots);
  return roots;
}

export function expandedFolders(path?: string): Set<string> {
  const parts = path?.split("/") ?? [];
  return new Set(parts.map((_, index) => parts.slice(0, index + 1).join("/")));
}
