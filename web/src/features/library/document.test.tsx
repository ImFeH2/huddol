import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RouterProvider } from "@/app/router";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  DocumentPage,
  DocumentUnavailable,
  documentCrumbs,
} from "@/features/library/document";

function render(path: string) {
  return renderToStaticMarkup(
    <TooltipProvider>
      <RouterProvider>
        <DocumentPage path={path} />
      </RouterProvider>
    </TooltipProvider>,
  );
}

describe("document hierarchy", () => {
  it("renders the full hierarchy with a non-clickable final segment", () => {
    const html = render("runbooks/on-call/notes.md");
    expect(html).toContain('aria-label="Breadcrumb"');
    expect(html).toContain(">Library</button>");
    expect(html).toContain(">runbooks</button>");
    expect(html).toContain(">on-call</button>");
    expect(html).toContain('<span aria-current="page">notes.md</span>');
    expect(html.match(/›/g)).toHaveLength(3);
    expect(html).not.toContain(">runbooks/on-call</span>");
  });

  it("navigates to the root or the selected folder's full path", () => {
    const navigate = vi.fn();
    const crumbs = documentCrumbs("runbooks/on-call/notes.md", navigate);
    for (const crumb of crumbs.slice(0, -1)) crumb.onSelect();
    expect(navigate.mock.calls).toEqual([
      [{ name: "library" }],
      [{ name: "library", path: "runbooks" }],
      [{ name: "library", path: "runbooks/on-call" }],
    ]);
  });

  it("keeps Library clickable for root documents and disables the unloaded editor", () => {
    const html = render("notes.md");
    expect(html).toContain(">Library</button>");
    expect(html.match(/›/g)).toHaveLength(1);
    expect(html).toMatch(/<textarea[^>]*disabled=""/);
  });
});

describe("document read failures", () => {
  it("shows only the not_readable title", () => {
    const html = renderToStaticMarkup(
      <DocumentUnavailable code="not_readable" />,
    );
    expect(html).toContain("<h3>Cannot open this file</h3>");
    expect(html).not.toContain("<p");
    expect(html).not.toContain("textarea");
  });

  it("preserves the missing document state", () => {
    expect(
      renderToStaticMarkup(<DocumentUnavailable code="not_found" />),
    ).toContain("Document not found");
  });
});
