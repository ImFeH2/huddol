import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Segmented } from "@/components/ui/segmented";

const options = [
  { value: "all", label: "All" },
  { value: "agents", label: "Agents" },
  { value: "humans", label: "Humans" },
] as const;

describe("Segmented", () => {
  it("names the group for assistive tech and presses only the current option", () => {
    const html = renderToStaticMarkup(
      <Segmented
        label="Filter by kind"
        value="agents"
        options={[...options]}
        onChange={() => {}}
      />,
    );
    expect(html).toContain(
      '<fieldset class="segmented"><legend class="visually-hidden">Filter by kind</legend>',
    );
    expect(html.match(/class="segment"/g)).toHaveLength(3);
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).toContain('aria-pressed="true">Agents</button>');
    expect(html).toContain('aria-pressed="false">All</button>');
  });
});
