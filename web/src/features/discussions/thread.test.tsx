import { useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Organization, OrganizationProvider } from "@/app/organization";
import { RouterProvider } from "@/app/router";
import { Avatar, AvatarStack } from "@/components/ui/index";
import { OverflowMenu } from "@/components/ui/menu";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  atDiscussionBottom,
  MessageRow,
  scrollDiscussionToBottom,
  ThreadPage,
} from "@/features/discussions/thread";
import type { DiscussionDetail, MessageMention } from "@/lib/backend";

vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return { ...react, useState: vi.fn(react.useState) };
});
vi.mock("@/components/ui/menu", () => ({ OverflowMenu: vi.fn(() => null) }));

afterEach(() => vi.clearAllMocks());

const organization: Organization = {
  members: [
    { id: 1, name: "You", type: "human", state: "idle" },
    { id: 2, name: "Helper", type: "agent", state: "idle" },
  ],
  humanId: 1,
  discussions: [],
  refresh: async () => {},
};

function render(
  pending: boolean,
  acknowledged: boolean,
  busy = false,
  mentions: MessageMention[] = [{ member_id: 1, position: 0, length: 4 }],
) {
  return renderToStaticMarkup(
    <TooltipProvider>
      <OrganizationProvider value={organization}>
        <MessageRow
          message={{
            id: 1,
            sender_id: 2,
            sender_name: "Helper",
            body: "@You please review",
            mentions,
            created_at: "2026-01-01T00:00:00Z",
          }}
          compact={false}
          fresh={false}
          pending={pending}
          acknowledged={acknowledged}
          busy={busy}
          onAck={() => {}}
          onRevoke={() => {}}
        />
      </OrganizationProvider>
    </TooltipProvider>,
  );
}

describe("message avatar", () => {
  it("uses the historical sender ID even when absent from current members", () => {
    function historical(senderName: string) {
      return renderToStaticMarkup(
        <TooltipProvider>
          <OrganizationProvider value={{ ...organization, members: [] }}>
            <MessageRow
              message={{
                id: 10,
                sender_id: 42,
                sender_name: senderName,
                body: "Historical message",
                mentions: [],
                created_at: "2026-01-01T00:00:00Z",
              }}
              compact={false}
              fresh={false}
              pending={false}
              acknowledged={false}
              busy={false}
              onAck={() => {}}
              onRevoke={() => {}}
            />
          </OrganizationProvider>
        </TooltipProvider>,
      );
    }
    const avatar = renderToStaticMarkup(<Avatar memberId={42} />);
    expect(historical("Deleted agent")).toContain(avatar);
    expect(historical("Renamed agent")).toContain(avatar);
    expect(historical("Renamed agent")).toContain("Renamed agent");
  });
});

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

describe("message mentions", () => {
  it("marks only the kernel-recorded spans", () => {
    expect(render(false, false)).toContain("<mark>@You</mark> please review");
    expect(render(false, false, false, [])).toContain("@You please review");
    expect(render(false, false, false, [])).not.toContain("<mark>");
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
    expect(html).toMatch(/<h1\b[^>]*>Release notes<\/h1>/);
    expect(html).toContain('placeholder="Message Release notes"');
    expect(html).toContain('aria-label="Voice input · Coming soon"');
    expect(html).toMatch(/<textarea[^>]*rows="1"[^>]*aria-label="Message"/);
    expect(html).not.toContain("crumb");
    expect(html).not.toContain("thread-strip");
    expect(html).not.toContain("thread-banner");
    expect(html).not.toContain("composer-hint");
  });

  it.each([false, true])(
    "has no delete action after loading archived=%s",
    (archived) => {
      const detail: DiscussionDetail = {
        id: 1,
        topic: "Release",
        members: [
          { id: 2, name: "Helper" },
          { id: 1, name: "You" },
        ],
        total_messages: 0,
        archived,
        read_through: 0,
        awaiting_ack: [],
        acknowledged: [],
        messages: [],
      };
      function LoadedThread() {
        vi.mocked(useState).mockReturnValueOnce([detail, vi.fn()]);
        return <ThreadPage id={1} />;
      }
      const html = renderToStaticMarkup(
        <TooltipProvider>
          <RouterProvider>
            <OrganizationProvider value={organization}>
              <LoadedThread />
            </OrganizationProvider>
          </RouterProvider>
        </TooltipProvider>,
      );
      expect(html).toMatch(/<h1\b[^>]*>Release<\/h1>/);
      expect(html).toContain(
        renderToStaticMarkup(<AvatarStack members={detail.members} />),
      );
      const { actions } = vi.mocked(OverflowMenu).mock.calls[0][0];
      expect(actions.map((action) => action.label)).toEqual([
        "Members",
        archived ? "Unarchive" : "Archive",
      ]);
      expect(html).not.toContain("Delete");
    },
  );

  it("never shows a loading heading for an unlisted thread", () => {
    const html = page([]);
    expect(html).toMatch(/<h1\b[^>]*><\/h1>/);
    expect(html).not.toContain("Loading");
    expect(html).toContain('placeholder="Message"');
  });
});

describe("composer resize scroll anchoring", () => {
  it("uses the true scroll end including the trailing 24px padding", () => {
    const area = { scrollHeight: 915, clientHeight: 600, scrollTop: 291.5 };
    expect(
      atDiscussionBottom(area.scrollHeight, area.clientHeight, area.scrollTop),
    ).toBe(false);
    scrollDiscussionToBottom(area);
    expect(area.scrollTop).toBe(315);
    expect(
      atDiscussionBottom(area.scrollHeight, area.clientHeight, area.scrollTop),
    ).toBe(true);
    area.scrollHeight = 983;
    scrollDiscussionToBottom(area);
    expect(area.scrollTop).toBe(383);
  });

  it("keeps short content at zero", () => {
    const area = { scrollHeight: 500, clientHeight: 600, scrollTop: 0 };
    scrollDiscussionToBottom(area);
    expect(area.scrollTop).toBe(0);
  });
  it("preserves bottom attachment with subpixel rounding", () => {
    expect(atDiscussionBottom(915, 623, 291.5)).toBe(true);
    expect(atDiscussionBottom(915, 623, 250)).toBe(false);
    expect(atDiscussionBottom(500, 623, 0)).toBe(true);
  });
});
