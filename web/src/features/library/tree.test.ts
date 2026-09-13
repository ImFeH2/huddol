import { describe, expect, it } from "vitest";
import { buildTree, expandedFolders } from "@/features/library/tree";
import type { LibraryEntry } from "@/lib/backend";

function entry(
  path: string,
  kind: LibraryEntry["kind"] = "file",
  hash: string | null = "hash",
): LibraryEntry {
  return {
    path,
    kind,
    hash: kind === "directory" ? null : hash,
    size: 12,
    modified_at: "2026-01-01T00:00:00Z",
  };
}

describe("buildTree", () => {
  it("nests unsorted entries by full parent path and counts all descendant files", () => {
    const entries = [
      entry("notes/deep/a.md"),
      entry("notes/b.md"),
      entry("notes/deep", "directory"),
      entry("notes", "directory"),
    ];
    const before = structuredClone(entries);
    const [root] = buildTree(entries);
    expect(root.path).toBe("notes");
    expect(root.fileCount).toBe(2);
    expect(root.children.map((node) => node.path)).toEqual([
      "notes/deep",
      "notes/b.md",
    ]);
    expect(root.children[0].children[0].path).toBe("notes/deep/a.md");
    expect(entries).toEqual(before);
  });

  it("sorts folders before files, alphabetically ignoring case at every level", () => {
    const tree = buildTree([
      entry("zebra", "directory"),
      entry("alpha", "directory"),
      entry("Beta.md"),
      entry("apple.md"),
      entry("alpha/Zoo.md"),
      entry("alpha/bird.md"),
      entry("alpha/zoo", "directory"),
    ]);
    expect(tree.map((node) => node.path)).toEqual([
      "alpha",
      "zebra",
      "apple.md",
      "Beta.md",
    ]);
    expect(tree[0].children.map((node) => node.path)).toEqual([
      "alpha/zoo",
      "alpha/bird.md",
      "alpha/Zoo.md",
    ]);
  });

  it("preserves empty folders and unreadable files", () => {
    const tree = buildTree([
      entry("empty", "directory"),
      entry("binary.dat", "file", null),
    ]);
    expect(tree[0]).toMatchObject({
      kind: "directory",
      children: [],
      fileCount: 0,
      hash: null,
    });
    expect(tree[1]).toMatchObject({
      kind: "file",
      path: "binary.dat",
      hash: null,
      fileCount: 1,
    });
    expect(buildTree([])).toEqual([]);
  });

  it("keeps identical folder names separate and accepts a listed subtree", () => {
    const tree = buildTree([
      entry("one/same", "directory"),
      entry("two/same", "directory"),
      entry("one/same/a.md"),
      entry("two/same/b.md"),
    ]);
    expect(tree).toHaveLength(2);
    expect(tree[0].children.map((node) => node.path)).toEqual([
      "one/same/a.md",
    ]);
    expect(tree[1].children.map((node) => node.path)).toEqual([
      "two/same/b.md",
    ]);
  });
});

describe("expandedFolders", () => {
  it("opens the destination and every ancestor, but no siblings", () => {
    expect([...expandedFolders("runbooks/on-call")]).toEqual([
      "runbooks",
      "runbooks/on-call",
    ]);
    expect([...expandedFolders()]).toEqual([]);
  });
});
