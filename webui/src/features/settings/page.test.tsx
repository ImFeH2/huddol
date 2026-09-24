import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RouterProvider } from "@/app/router";
import { SettingsPage } from "@/features/settings/page";
import { isSettingsSaving } from "@/features/settings/saver";

describe("Settings save navigation", () => {
  it("stays blocked until every active save finishes", () => {
    expect(isSettingsSaving({})).toBe(false);
    expect(isSettingsSaving({ model: true, agent: false })).toBe(true);
    expect(isSettingsSaving({ model: false, agent: false })).toBe(false);
  });
});

describe("Settings page", () => {
  it("shows one tab per section and the requested panel", () => {
    const html = renderToStaticMarkup(
      <RouterProvider>
        <SettingsPage section="agent" />
      </RouterProvider>,
    );
    expect(html).toMatch(/<h1\b[^>]*>Settings<\/h1>/);
    for (const label of ["Model", "Execution", "Agent", "Langfuse"]) {
      expect(html).toContain(`>${label}</button>`);
    }
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("0 means no ceiling.");
    expect(html).toContain('aria-label="Agent settings"');
    expect(html).toContain(">Context</h3>");
    expect(html).toContain(">Run limits</h3>");
    expect(html).toContain(">Reminders and pausing</h3>");
    expect(html.match(/<form/g)).toHaveLength(1);
    expect(html).not.toContain(">Limits</button>");
    expect(
      Array.from(
        html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g),
        ([, text]) => text,
      ),
    ).toEqual([
      "0 means no ceiling.",
      "0 means unlimited. Changes apply to new Turns.",
    ]);
  });
});
