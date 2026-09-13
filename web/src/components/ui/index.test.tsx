import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AvatarStack,
  autoGrowHeight,
  Button,
  Field,
  hueFor,
  IconButton,
  initialsFor,
  Textarea,
} from "@/components/ui/index";
import { Tooltip, TooltipProvider } from "@/components/ui/tooltip";

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

describe("Button", () => {
  it("keeps its classes and label when used as a tooltip trigger", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <Tooltip label="x">
          <Button variant="ghost" aria-label="Members">
            y
          </Button>
        </Tooltip>
      </TooltipProvider>,
    );
    expect(html).toMatch(/<button[^>]*class="[^"]*inline-flex/);
    expect(html).toContain('aria-label="Members"');
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
    expect(html).not.toContain("aria-pressed=");
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
    for (const initials of ["YO", "MA", "SC", "DA", "OP"]) {
      expect(html).toContain(`>${initials}</span>`);
    }
    expect(html).not.toContain(">QA</span>");
    expect(html).not.toContain(">PM</span>");
    expect(html).toContain("+2");
    expect(html).toContain('aria-label="You, Main, Scout, Data, Ops, QA, PM"');
  });

  it("shows no count when everyone fits", () => {
    const html = renderToStaticMarkup(<AvatarStack names={["You", "Main"]} />);
    expect(html).toContain(">YO</span>");
    expect(html).toContain(">MA</span>");
    expect(html).not.toMatch(/>\+\d+</);
  });
});

describe("Textarea auto grow", () => {
  it("follows the content height until the row ceiling", () => {
    expect(autoGrowHeight(56, 20, 16, 2, 8)).toBe(58);
    expect(autoGrowHeight(400, 20, 16, 2, 8)).toBe(178);
    expect(autoGrowHeight(400, 20, 16, 2)).toBe(402);
  });

  it("preserves the label and initial row count when auto growing", () => {
    const html = renderToStaticMarkup(
      <Textarea autoGrow rows={1} aria-label="Message" />,
    );
    expect(html).toMatch(/<textarea[^>]*rows="1"[^>]*aria-label="Message"/);
    expect(renderToStaticMarkup(<Textarea aria-label="Notes" />)).toMatch(
      /<textarea[^>]*aria-label="Notes"/,
    );
  });
});

describe("Field", () => {
  it("links a label to its control and keeps the hint after it", () => {
    const html = renderToStaticMarkup(
      <Field label="Name" htmlFor="name" hint="Required">
        <input id="name" />
      </Field>,
    );
    expect(html).toMatch(
      /<label[^>]*for="name">Name<\/label><input id="name"\/><p[^>]*>Required<\/p>/,
    );
  });

  it("renders unassociated group text as a span", () => {
    const html = renderToStaticMarkup(
      <Field label="Provider">
        <fieldset aria-label="Provider">Options</fieldset>
      </Field>,
    );
    expect(html).toMatch(
      /<span[^>]*>Provider<\/span><fieldset aria-label="Provider">Options<\/fieldset>/,
    );
    expect(html).not.toContain("<label");
  });
});
