import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OrganizationProvider } from "@/app/organization";
import { RouterProvider } from "@/app/router";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DiscussionsPage } from "@/features/discussions/list";

describe("discussions page", () => {
  it("offers search, an archived toggle and the primary action, and nothing else before the list loads", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <RouterProvider>
          <OrganizationProvider
            value={{
              members: [{ id: 1, name: "You", type: "human", state: "idle" }],
              humanId: 1,
              discussions: [],
              refresh: async () => {},
            }}
          >
            <DiscussionsPage />
          </OrganizationProvider>
        </RouterProvider>
      </TooltipProvider>,
    );
    expect(html).toContain("<h1>Discussions</h1>");
    expect(html).toContain('placeholder="Search messages"');
    expect(html).toContain('aria-label="Show archived"');
    expect(html).toContain('aria-pressed="false"');
    expect(html.match(/New Discussion/g)).toHaveLength(1);
    expect(html).not.toContain("No Discussions yet");
    expect(html).not.toContain("count-pill");
    expect(html).not.toContain("Refresh");
  });
});
