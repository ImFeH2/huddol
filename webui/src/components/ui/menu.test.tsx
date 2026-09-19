import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OverflowMenu } from "@/components/ui/menu";

describe("OverflowMenu", () => {
  it("keeps the trigger when every action is disabled", () => {
    const html = renderToStaticMarkup(
      <OverflowMenu
        label="Actions for Helper"
        actions={[
          { id: "delete", label: "Delete", disabled: true, onSelect: () => {} },
        ]}
      />,
    );
    expect(html).toContain('aria-label="Actions for Helper"');
    expect(html).toContain('aria-haspopup="menu"');
  });

  it("renders nothing without actions", () => {
    expect(
      renderToStaticMarkup(<OverflowMenu label="Actions" actions={[]} />),
    ).toBe("");
  });
});
