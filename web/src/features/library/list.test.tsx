import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  deleteConsequence,
  LibraryContents,
  libraryActions,
} from "@/features/library/list";
import type { LibraryEntry } from "@/lib/backend";

const entries: LibraryEntry[] = [
  {
    path: "runbooks",
    kind: "directory",
    size: 0,
    hash: null,
    modified_at: "2026-01-01T00:00:00Z",
  },
  {
    path: "runbooks/deep",
    kind: "directory",
    size: 0,
    hash: null,
    modified_at: "2026-01-01T00:00:00Z",
  },
  {
    path: "runbooks/deep/notes.md",
    kind: "file",
    size: 1200,
    hash: "hash",
    modified_at: "2026-01-01T00:00:00Z",
  },
  {
    path: "runbooks/image.png",
    kind: "file",
    size: 2048,
    hash: null,
    modified_at: "2026-01-01T00:00:00Z",
  },
  {
    path: "empty",
    kind: "directory",
    size: 0,
    hash: null,
    modified_at: "2026-01-01T00:00:00Z",
  },
];

const handlers = () => ({ create: vi.fn(), rename: vi.fn(), remove: vi.fn() });

function render(expanded: string[] = [], query = "", data = entries) {
  return renderToStaticMarkup(
    <TooltipProvider>
      <LibraryContents
        entries={data}
        expanded={new Set(expanded)}
        query={query}
        onToggle={() => {}}
        onOpen={() => {}}
        onCreate={() => {}}
        rowActions={(entry) => libraryActions(entry, handlers())}
      />
    </TooltipProvider>,
  );
}

describe("Library tree", () => {
  it("renders collapsed folders with recursive file counts and retains empty folders", () => {
    const html = render();
    expect(html).toContain('aria-label="Library documents"');
    expect(html).toContain("2 documents");
    expect(html).toContain("runbooks");
    expect(html).toContain("empty");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(">2</p>");
    expect(html).toContain(">0</p>");
    expect(html).not.toContain("notes.md");
    expect(html).not.toContain("image.png");
  });

  it("renders only expanded levels", () => {
    const html = render(["runbooks"]);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("deep");
    expect(html).toContain("image.png");
    expect(html).not.toContain("notes.md");
    expect(render(["runbooks", "runbooks/deep"])).toContain("notes.md");
  });

  it("does not link unreadable files but keeps their actions and size", () => {
    const html = render([], "image");
    expect(html).toContain("Unreadable");
    expect(html).not.toContain('class="row-link"');
    expect(html).toContain('aria-label="Actions for runbooks/image.png"');
    expect(html).toContain("2.0 kB");
  });

  it("flattens path matches without needing expansion and shows folder chips", () => {
    const html = render([], "  DEEP/NOTES  ");
    expect(html).toContain("1 document");
    expect(html).toContain("notes.md");
    expect(html).toContain(">runbooks/deep</span>");
    expect(html).not.toContain('aria-expanded="true"');
    expect(html).not.toContain('aria-label="Actions for runbooks"');
    expect(html).not.toContain("image.png");
  });

  it("shows timestamps with exact-time tooltip triggers instead of titles", () => {
    const html = render(["runbooks", "runbooks/deep"]);
    expect(html).toMatch(/<time[^>]*datetime="2026-01-01T00:00:00Z"/i);
    expect(html).not.toContain("title=");
    expect(html).toContain("Modified");
  });

  it("offers both creation actions only for the empty Library", () => {
    const html = render([], "", []);
    expect(html).toContain("The Library is empty");
    expect(html).toContain("New document");
    expect(html).toContain('aria-label="New folder"');
    const filtered = render([], "nothing-matches");
    expect(filtered).toContain("No documents match");
    expect(filtered).not.toContain("New document");
  });

  it("does not treat a Library containing only empty folders as empty", () => {
    const html = render([], "", [entries[4]]);
    expect(html).toContain("0 documents");
    expect(html).toContain('aria-label="Library documents"');
    expect(html).not.toContain("The Library is empty");
  });
});

describe("Library row actions", () => {
  it("offers files Rename and Delete and dispatches the selected file", () => {
    const callbacks = handlers();
    const actions = libraryActions(entries[2], callbacks);
    expect(actions.map((action) => action.label)).toEqual(["Rename", "Delete"]);
    actions[0].onSelect();
    actions[1].onSelect();
    expect(callbacks.rename).toHaveBeenCalledWith(entries[2]);
    expect(callbacks.remove).toHaveBeenCalledWith(entries[2]);
  });

  it("offers folder creation actions prefilled with its full path", () => {
    const callbacks = handlers();
    const actions = libraryActions(entries[1], callbacks);
    expect(actions.map((action) => action.label)).toEqual([
      "Rename",
      "New document inside",
      "New folder inside",
      "Delete",
    ]);
    actions[1].onSelect();
    actions[2].onSelect();
    expect(callbacks.create.mock.calls).toEqual([
      [{ kind: "file", initial: "runbooks/deep/" }],
      [{ kind: "directory", initial: "runbooks/deep/" }],
    ]);
  });

  it("names all files removed by a folder delete, including unreadable files", () => {
    expect(deleteConsequence(entries[0], entries)).toBe(
      "Removes 2 files for every Member.",
    );
    expect(deleteConsequence(entries[1], entries)).toBe(
      "Removes 1 file for every Member.",
    );
    expect(deleteConsequence(entries[4], entries)).toBe(
      "Removes 0 files for every Member.",
    );
    expect(deleteConsequence(entries[2], entries)).toBe(
      "The document is removed for every Member.",
    );
    expect(
      deleteConsequence(entries[0], [
        ...entries,
        { ...entries[2], path: "runbooks-other/notes.md" },
      ]),
    ).toBe("Removes 2 files for every Member.");
  });
});
