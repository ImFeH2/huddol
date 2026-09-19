import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  Combobox,
  filterOptions,
  optionIndexAfterKey,
} from "@/components/ui/combobox";
import { TooltipProvider } from "@/components/ui/tooltip";

const options = ["Alpha", "alpha-mini", "Beta"];

describe("Combobox", () => {
  it("renders an editable named combobox and a trailing chooser", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <Combobox
          id="model"
          label="Model"
          value="custom-model"
          options={options}
          onChange={() => {}}
          chooseLabel="Choose model"
        />
      </TooltipProvider>,
    );
    expect(html).toMatch(/<input[^>]*id="model"[^>]*role="combobox"/);
    expect(html).toContain('aria-label="Model"');
    expect(html).toContain('aria-autocomplete="list"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('value="custom-model"');
    expect(html).toMatch(
      /<button[^>]*type="button"[^>]*aria-label="Choose model"/,
    );
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).not.toContain("readonly");
    expect(html).not.toContain('role="listbox"');
  });
});

describe("filterOptions", () => {
  it("matches a case-insensitive substring with trimmed query whitespace", () => {
    expect(filterOptions(options, " ALPHA ")).toEqual(["Alpha", "alpha-mini"]);
    expect(filterOptions(options, "mini")).toEqual(["alpha-mini"]);
  });

  it("returns all options for an empty query without changing their order", () => {
    expect(filterOptions(options, "   ")).toEqual(options);
    expect(options).toEqual(["Alpha", "alpha-mini", "Beta"]);
  });

  it("allows free text absent from the list, including an empty list", () => {
    expect(filterOptions(options, "custom-model")).toEqual([]);
    expect(filterOptions([], "custom-model")).toEqual([]);
  });
});

describe("optionIndexAfterKey", () => {
  it("starts at either end and wraps in both directions", () => {
    expect(optionIndexAfterKey("ArrowDown", -1, 3)).toBe(0);
    expect(optionIndexAfterKey("ArrowUp", -1, 3)).toBe(2);
    expect(optionIndexAfterKey("ArrowDown", 2, 3)).toBe(0);
    expect(optionIndexAfterKey("ArrowUp", 0, 3)).toBe(2);
    expect(optionIndexAfterKey("ArrowUp", 2, 3)).toBe(1);
  });

  it("leaves an empty list unselected and ignores other keys", () => {
    expect(optionIndexAfterKey("ArrowDown", -1, 0)).toBe(-1);
    expect(optionIndexAfterKey("ArrowUp", -1, 0)).toBe(-1);
    expect(optionIndexAfterKey("Enter", 1, 3)).toBe(1);
    expect(optionIndexAfterKey("Escape", 1, 3)).toBe(1);
  });
});
