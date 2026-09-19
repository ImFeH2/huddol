import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Tabs, tabIndexAfterKey } from "@/components/ui/tabs";

const tabs = [
  { id: "model", label: "Model" },
  { id: "agent", label: "Agent" },
  { id: "langfuse", label: "Langfuse" },
] as const;

describe("tabIndexAfterKey", () => {
  it("moves sideways and wraps around", () => {
    expect(tabIndexAfterKey("ArrowRight", 0, 3)).toBe(1);
    expect(tabIndexAfterKey("ArrowRight", 2, 3)).toBe(0);
    expect(tabIndexAfterKey("ArrowLeft", 0, 3)).toBe(2);
  });

  it("jumps to the ends", () => {
    expect(tabIndexAfterKey("Home", 2, 3)).toBe(0);
    expect(tabIndexAfterKey("End", 0, 3)).toBe(2);
  });

  it("ignores other keys", () => {
    expect(tabIndexAfterKey("Enter", 1, 3)).toBeNull();
    expect(tabIndexAfterKey("ArrowDown", 1, 3)).toBeNull();
  });
});

describe("Tabs", () => {
  it("wires the selected tab to its panel with roving focus", () => {
    const html = renderToStaticMarkup(
      <Tabs label="Settings" tabs={[...tabs]} value="agent" onChange={() => {}}>
        <p>0 means no ceiling.</p>
      </Tabs>,
    );
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-label="Settings"');
    expect(html.match(/role="tab"/g)).toHaveLength(3);
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(html.match(/tabindex="-1"/g)).toHaveLength(2);
    const selected = html.match(
      /<button[^>]*id="([^"]+)"[^>]*aria-selected="true"[^>]*aria-controls="([^"]+)"/,
    );
    expect(selected).not.toBeNull();
    expect(html).toContain(
      `role="tabpanel" id="${selected?.[2]}" aria-labelledby="${selected?.[1]}"`,
    );
    expect(html).toContain("0 means no ceiling.");
  });
});
