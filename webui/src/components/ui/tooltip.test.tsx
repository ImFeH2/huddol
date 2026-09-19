import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Tooltip, TooltipProvider } from "@/components/ui/tooltip";

describe("Tooltip", () => {
  it("can give static data a keyboard-focusable trigger", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <Tooltip label="Exact time" focusable>
          <time>Yesterday</time>
        </Tooltip>
      </TooltipProvider>,
    );
    expect(html).toMatch(/<button[^>]*type="button"/);
    expect(html).toContain("<time>Yesterday</time></button>");
    expect(html).not.toContain("title=");
  });

  it("keeps existing interactive children as the trigger", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <Tooltip label="Save">
          <button type="button">Save</button>
        </Tooltip>
      </TooltipProvider>,
    );
    expect(html.match(/<button/g)).toHaveLength(1);
  });
});
