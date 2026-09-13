import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrganizationProvider } from "@/app/organization";
import { RouterProvider } from "@/app/router";
import { ConfirmDialog } from "@/components/ui/dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TreeView } from "@/features/library/tree-view";
import {
  AgentDetailStatus,
  MemberPage,
  MemoryContent,
  MemorySection,
} from "@/features/members/detail";
import { type AgentDetail, backend, type LibraryEntry } from "@/lib/backend";

vi.mock("@/components/ui/dialog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/ui/dialog")>()),
  ConfirmDialog: vi.fn(() => null),
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

const detail: AgentDetail = {
  id: 2,
  todos: [],
  memory: [],
  runs: [],
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    requests: 0,
    total_tokens: 0,
  },
  token_limit: 0,
  over_token_limit: false,
  idle: false,
  idle_streak: 0,
  window: { number: 1, since_sequence: 0, reset_at: null, reason: null },
};
const entries: LibraryEntry[] = [
  {
    path: "notes",
    kind: "directory",
    hash: null,
    size: 0,
    modified_at: "2026-01-01T00:00:00Z",
  },
  {
    path: "notes/MEMORY.md",
    kind: "file",
    hash: "hash",
    size: 5,
    modified_at: "2026-01-01T00:00:00Z",
  },
];

function status(value: AgentDetail) {
  return renderToStaticMarkup(
    <TooltipProvider>
      <AgentDetailStatus detail={value} />
    </TooltipProvider>,
  );
}

describe("Agent deletion", () => {
  it("describes leaving Discussions and keeps the delete action", async () => {
    const refresh = vi.fn(async () => {});
    const remove = vi
      .spyOn(backend, "deleteAgent")
      .mockResolvedValue({ id: 2 });
    renderToStaticMarkup(
      <TooltipProvider>
        <RouterProvider>
          <OrganizationProvider
            value={{
              members: [
                { id: 2, name: "Helper", type: "agent", state: "idle" },
              ],
              humanId: 1,
              discussions: [],
              refresh,
            }}
          >
            <MemberPage id={2} />
          </OrganizationProvider>
        </RouterProvider>
      </TooltipProvider>,
    );
    const confirmation = vi.mocked(ConfirmDialog).mock.calls[0][0];
    expect(confirmation.title).toBe("Delete Helper?");
    expect(confirmation.description).toBe(
      "It leaves every Discussion and stops running.",
    );
    expect(confirmation.confirmLabel).toBe("Delete Agent");
    await confirmation.onConfirm();
    expect(remove).toHaveBeenCalledExactlyOnceWith(2);
    expect(refresh).toHaveBeenCalledOnce();
  });
});

describe("Agent detail status", () => {
  it("uses the kernel idle flag even below the previous threshold", () => {
    expect(status({ ...detail, idle: true, idle_streak: 1 })).toContain(
      "1 idle Turn",
    );
    expect(status({ ...detail, idle: false, idle_streak: 20 })).not.toContain(
      "idle Turn",
    );
    expect(status({ ...detail, idle: true, idle_streak: 1000 })).toContain(
      "1,000 idle Turns",
    );
  });

  it("shows later windows but not the initial window", () => {
    expect(status(detail)).not.toContain("Window");
    const html = status({
      ...detail,
      window: {
        number: 1200,
        since_sequence: 10,
        reset_at: "2026-01-01T00:00:00Z",
        reason: "budget",
      },
    });
    expect(html).toContain("Window 1,200");
    expect(html).toContain("<button");
    expect(html).not.toContain("title=");
  });
});

describe("Memory tree", () => {
  it("uses the shared tree with collapsed folders and file counts", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <MemorySection agentId={2} entries={entries} />
      </TooltipProvider>,
    );
    expect(html).toContain("<h2>Memory</h2>");
    expect(html).toContain('aria-label="Memory files"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("notes");
    expect(html).toContain(">1</p>");
    expect(html).not.toContain("MEMORY.md");
    expect(html).not.toContain("Actions");
  });

  it("opens readable files in read-only mode and suppresses all actions", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <TreeView
          entries={entries}
          expanded={new Set(["notes"])}
          onToggle={() => {}}
          onOpen={() => {}}
          readOnly
          rowActions={() => [
            { id: "delete", label: "Delete", onSelect: () => {} },
          ]}
        />
      </TooltipProvider>,
    );
    expect(html).toContain("MEMORY.md");
    expect(html).toContain('aria-expanded="true"');
    expect(html).not.toContain("Delete");
    expect(html).not.toContain("Actions");
  });

  it("preserves the empty Memory state", () => {
    expect(
      renderToStaticMarkup(<MemorySection agentId={2} entries={[]} />),
    ).toContain("No Memory files");
  });

  it("renders escaped, read-only content and its UTF-8 byte size without actions", () => {
    const html = renderToStaticMarkup(
      <MemoryContent
        file={{ path: "notes/MEMORY.md", content: "<中文>\n", hash: "hash" }}
      />,
    );
    expect(html).toContain("9 B");
    expect(html).toContain("&lt;中文&gt;\n</pre>");
    expect(html).not.toContain("textarea");
    expect(html).not.toContain("button");
    expect(html).not.toContain("contenteditable");
  });
});
