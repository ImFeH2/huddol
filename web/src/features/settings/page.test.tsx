import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RouterProvider } from "@/app/router";
import { SettingsPage } from "@/features/settings/page";

describe("Settings page", () => {
  it("shows one tab per section and the requested panel", () => {
    const html = renderToStaticMarkup(
      <RouterProvider>
        <SettingsPage section="agent" />
      </RouterProvider>,
    );
    expect(html).toContain("<h1>Settings</h1>");
    for (const label of ["Model", "Execution", "Agent", "Langfuse"]) {
      expect(html).toContain(`>${label}</button>`);
    }
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("0 means no ceiling.");
    expect(html).toContain('aria-label="Agent settings"');
    expect(html).not.toContain(">Limits</button>");
    expect(html).not.toContain("page-lede");
    expect(html).not.toContain("section-lede");
  });
});
