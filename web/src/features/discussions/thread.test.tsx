import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { type Organization, OrganizationProvider } from "@/app/organization";
import { RouterProvider } from "@/app/router";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MessageRow, ThreadPage } from "@/features/discussions/thread";

const organization: Organization = {
  members: [
    { id: 1, name: "You", type: "human", state: "idle" },
    { id: 2, name: "Helper", type: "agent", state: "idle" },
  ],
  humanId: 1,
  discussions: [],
  refresh: async () => {},
};

function render(pending: boolean, acknowledged: boolean, busy = false) {
  return renderToStaticMarkup(
    <TooltipProvider>
      <OrganizationProvider value={organization}>
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
      </OrganizationProvider>
    </TooltipProvider>,
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

describe("message timestamp", () => {
  it("keeps the exact time in a tooltip instead of a title attribute", () => {
    const html = render(false, false);
    expect(html).toMatch(/<time[^>]*datetime="2026-01-01T00:00:00Z"/i);
    expect(html).not.toContain("title=");
  });
});

describe("thread page", () => {
  function page(discussions: Organization["discussions"]) {
    return renderToStaticMarkup(
      <TooltipProvider>
        <RouterProvider>
          <OrganizationProvider value={{ ...organization, discussions }}>
            <ThreadPage id={1} />
          </OrganizationProvider>
        </RouterProvider>
      </TooltipProvider>,
    );
  }

  it("seeds the title and composer from the listed topic before the thread loads", () => {
    const html = page([
      {
        id: 1,
        topic: "Release notes",
        member_ids: [1, 2],
        archived: false,
        unread: 0,
      },
    ]);
    expect(html).toContain("<h1>Release notes</h1>");
    expect(html).toContain('placeholder="Message Release notes"');
    expect(html).toContain('aria-label="Send · Enter"');
    expect(html).toContain('data-auto-grow="true"');
    expect(html).not.toContain("crumb");
    expect(html).not.toContain("thread-strip");
    expect(html).not.toContain("composer-hint");
  });

  it("never shows a loading heading for an unlisted thread", () => {
    const html = page([]);
    expect(html).toContain("<h1></h1>");
    expect(html).not.toContain("Loading");
    expect(html).toContain('placeholder="Message"');
  });
});
