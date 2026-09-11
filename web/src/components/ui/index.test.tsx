import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AvatarStack,
  autoGrowHeight,
  hueFor,
  IconButton,
  initialsFor,
  Textarea,
} from "@/components/ui/index";
import { TooltipProvider } from "@/components/ui/tooltip";

describe("initialsFor", () => {
  it("uses the first two letters of a single word", () => {
    expect(initialsFor("Main")).toBe("MA");
  });

  it("uses first and last initials for multi word names", () => {
    expect(initialsFor("Technical Manager")).toBe("TM");
    expect(initialsFor("Product Advisor")).toBe("PA");
  });

  it("collapses extra whitespace", () => {
    expect(initialsFor("  Technical   Manager  ")).toBe("TM");
  });

  it("falls back for an empty name", () => {
    expect(initialsFor("   ")).toBe("?");
  });

  it("handles non latin names without crashing", () => {
    expect(initialsFor("产品顾问")).toBe("产品");
  });
});

describe("hueFor", () => {
  it("is stable for the same name", () => {
    expect(hueFor("Main")).toBe(hueFor("Main"));
  });

  it("returns a token reference", () => {
    expect(hueFor("Main")).toMatch(/^var\(--/);
  });

  it("spreads real member names across more than one hue", () => {
    const names = ["You", "Main", "Technical Manager", "Product Advisor"];
    expect(new Set(names.map(hueFor)).size).toBeGreaterThan(1);
  });
});

describe("IconButton", () => {
  it("labels the button for assistive tech and a tooltip instead of a title", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <IconButton label="Show archived">x</IconButton>
      </TooltipProvider>,
    );
    expect(html).toContain('aria-label="Show archived"');
    expect(html).not.toContain("title=");
    expect(html).not.toContain("aria-pressed");
  });

  it("exposes a pressed state", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <IconButton label="Show archived" pressed>
          x
        </IconButton>
      </TooltipProvider>,
    );
    expect(html).toContain('aria-pressed="true"');
  });
});

describe("AvatarStack", () => {
  it("shows up to the limit and folds the rest into a count", () => {
    const html = renderToStaticMarkup(
      <AvatarStack
        names={["You", "Main", "Scout", "Data", "Ops", "QA", "PM"]}
      />,
    );
    expect(html.match(/class="avatar"/g)).toHaveLength(5);
    expect(html).toContain("+2");
    expect(html).toContain('aria-label="You, Main, Scout, Data, Ops, QA, PM"');
  });

  it("shows no count when everyone fits", () => {
    const html = renderToStaticMarkup(<AvatarStack names={["You", "Main"]} />);
    expect(html.match(/class="avatar"/g)).toHaveLength(2);
    expect(html).not.toContain("avatar-more");
  });
});

describe("Textarea auto grow", () => {
  it("follows the content height until the row ceiling", () => {
    expect(autoGrowHeight(56, 20, 16, 2, 8)).toBe(58);
    expect(autoGrowHeight(400, 20, 16, 2, 8)).toBe(178);
    expect(autoGrowHeight(400, 20, 16, 2)).toBe(402);
  });

  it("marks the field so styling can drop the fixed minimum", () => {
    expect(
      renderToStaticMarkup(<Textarea autoGrow rows={1} aria-label="Message" />),
    ).toContain('data-auto-grow="true"');
    expect(renderToStaticMarkup(<Textarea aria-label="Notes" />)).not.toContain(
      "data-auto-grow",
    );
  });
});
