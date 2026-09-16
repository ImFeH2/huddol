import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Avatar } from "@/components/ui/index";
import { MemberPicker } from "@/features/discussions/members";

function render(disabled = false) {
  return renderToStaticMarkup(
    <MemberPicker
      members={[
        { id: 1, name: "You", type: "human", state: "idle" },
        { id: 2, name: "Helper", type: "agent", state: "idle" },
      ]}
      selected={[1]}
      onChange={() => {}}
      disabled={disabled}
    />,
  );
}

describe("discussion member picker", () => {
  it("uses the shared pattern for each member ID", () => {
    const html = render();
    for (const id of [1, 2]) {
      expect(html).toContain(
        renderToStaticMarkup(<Avatar memberId={id} size="sm" />),
      );
    }
  });

  it("renders labelled members with their current selection", () => {
    const html = render();
    expect(html).toContain("You");
    expect(html).toContain("Helper");
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html.match(/checked=""/g)).toHaveLength(1);
  });

  it("links labels to unique controls across picker instances", () => {
    const html = renderToStaticMarkup(
      [0, 1].map((key) => (
        <MemberPicker
          key={key}
          members={[{ id: 1, name: "You", type: "human", state: "idle" }]}
          selected={[]}
          onChange={() => {}}
        />
      )),
    );
    const ids = [...html.matchAll(/<input[^>]*\bid="([^"]+)"/g)].map(
      (match) => match[1],
    );
    const labels = [...html.matchAll(/<label[^>]*\bfor="([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(labels).toEqual(ids);
  });

  it("names the empty state when there is nobody to pick", () => {
    const html = renderToStaticMarkup(
      <MemberPicker members={[]} selected={[]} onChange={() => {}} />,
    );
    expect(html).toContain("No other Members");
    expect(html).not.toContain('type="checkbox"');
  });

  it("disables the selection while saving", () => {
    expect(render(true)).toMatch(/<fieldset\b[^>]*\bdisabled=""/);
  });
});
