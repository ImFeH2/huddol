import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OrganizationProvider } from "../../app/organization";
import { MessageRow } from "./thread";

function render(pending: boolean, acknowledged: boolean, busy = false) {
  return renderToStaticMarkup(
    <OrganizationProvider
      value={{
        members: [
          { id: 1, name: "You", type: "human", state: "idle" },
          { id: 2, name: "Helper", type: "agent", state: "idle" },
        ],
        humanId: 1,
        refresh: async () => {},
      }}
    >
      <MessageRow
        message={{
          id: 1,
          sender_id: 2,
          sender_name: "Helper",
          body: "@You please review",
          created_at: "2026-01-01T00:00:00Z",
        }}
        compact={false}
        fresh={false}
        pending={pending}
        acknowledged={acknowledged}
        busy={busy}
        memberIds={new Set([1, 2])}
        onAck={() => {}}
        onRevoke={() => {}}
      />
    </OrganizationProvider>,
  );
}

describe("message acknowledgement", () => {
  it("offers confirmation for a pending mention", () => {
    const html = render(true, false);
    expect(html).toContain("Mark handled");
    expect(html).not.toContain("Undo confirmation");
  });

  it("offers undo for the current member's confirmation", () => {
    const html = render(false, true);
    expect(html).toContain("Handled");
    expect(html).toContain('aria-label="Undo confirmation"');
    expect(html).not.toContain("Mark handled");
  });

  it("offers no confirmation actions for other messages", () => {
    const html = render(false, false);
    expect(html).not.toContain("Undo confirmation");
    expect(html).not.toContain("Mark handled");
  });

  it("disables undo while a change is pending", () => {
    expect(render(false, true, true)).toContain('disabled=""');
  });
});
