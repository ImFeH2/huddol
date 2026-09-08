import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MemberPicker } from "./members";

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
  it("renders labelled members with their current selection", () => {
    const html = render();
    expect(html).toContain("You");
    expect(html).toContain("Helper");
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html.match(/checked=""/g)).toHaveLength(1);
    expect(html.match(/class="checkbox"/g)).toHaveLength(2);
  });

  it("disables the selection while saving", () => {
    expect(render(true)).toContain(
      '<fieldset class="member-picker" disabled="">',
    );
  });
});
