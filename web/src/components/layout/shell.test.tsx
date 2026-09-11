import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  Nav,
  NavItem,
  NavSubItem,
  PageHeader,
  PageTransition,
  Shell,
  Sidebar,
  Table,
} from "@/components/layout/shell";
import { Badge, Banner, Chip, IconButton } from "@/components/ui/index";
import { TooltipProvider } from "@/components/ui/tooltip";

describe("Shell feedback", () => {
  it("keeps the page and navigation alongside one live failure notice", () => {
    const html = renderToStaticMarkup(
      <Shell
        sidebar={<nav>Navigation</nav>}
        notice={<Banner tone="danger">Connection lost. Restart Huddol.</Banner>}
      >
        <main>Draft editor</main>
      </Shell>,
    );
    expect(html).toContain("<nav>Navigation</nav>");
    expect(html).toContain("<main>Draft editor</main>");
    expect(html.match(/role="status"/g)).toHaveLength(1);
    expect(html).toContain("Connection lost. Restart Huddol.");
  });
});

describe("Sidebar navigation", () => {
  it("nests sub items under an item with a trailing action", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <Sidebar footer={<span>Footer</span>}>
          <Nav label="Sections">
            <NavItem
              icon={<span>i</span>}
              label="Discussions"
              active={false}
              badge={<Badge tone="unread">3</Badge>}
              trailing={
                <IconButton size="sm" label="New Discussion">
                  +
                </IconButton>
              }
              onSelect={() => {}}
            >
              <NavSubItem
                label="Ship the release notes"
                active
                badge={<Badge tone="unread">1</Badge>}
                indicator={<i>dot</i>}
                onSelect={() => {}}
              />
              <NavSubItem
                label="Weekly review"
                active={false}
                onSelect={() => {}}
              />
            </NavItem>
            <NavItem
              icon={<span>i</span>}
              label="Members"
              active={false}
              onSelect={() => {}}
            />
          </Nav>
        </Sidebar>
      </TooltipProvider>,
    );
    expect(html).toContain('aria-label="New Discussion"');
    expect(html.match(/class="nav-subitem"/g)).toHaveLength(2);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toContain('aria-current="page" data-unread="true"');
    expect(html).toContain("<i>dot</i>");
    expect(html.match(/class="nav-sublist"/g)).toHaveLength(1);
    expect(html).toContain('<div class="sidebar-footer"><span>Footer</span>');
  });

  it("renders an item without children flat", () => {
    const html = renderToStaticMarkup(
      <Nav label="Sections">
        <NavItem
          icon={<span>i</span>}
          label="Library"
          active
          onSelect={() => {}}
        />
      </Nav>,
    );
    expect(html).not.toContain("nav-sublist");
    expect(html).not.toContain("nav-trailing");
    expect(html).toContain('data-active="true"');
  });
});

describe("PageTransition", () => {
  it("wraps the page in the animated container", () => {
    const html = renderToStaticMarkup(
      <PageTransition id="discussion:1">
        <main>Thread</main>
      </PageTransition>,
    );
    expect(html).toBe('<div class="page-transition"><main>Thread</main></div>');
  });
});

describe("PageHeader", () => {
  it("shows real state in the status slot under the title", () => {
    const html = renderToStaticMarkup(
      <PageHeader
        title="Ship the release notes"
        status={<Chip>Archived</Chip>}
      />,
    );
    expect(html).toContain("<h1>Ship the release notes</h1>");
    expect(html).toContain(
      '<div class="page-status"><span class="chip" data-tone="neutral">Archived</span></div>',
    );
    expect(html).not.toContain("page-lede");
  });

  it("renders no status slot without state", () => {
    expect(renderToStaticMarkup(<PageHeader title="Members" />)).not.toContain(
      "page-status",
    );
  });
});

describe("Table", () => {
  it("names the unlabeled actions column for assistive tech only", () => {
    const html = renderToStaticMarkup(
      <Table
        columns={[
          { key: "name", label: "Name" },
          { key: "actions", label: "" },
        ]}
        label="Members"
      >
        <tr>
          <td>You</td>
          <td />
        </tr>
      </Table>,
    );
    expect(html).toContain('<span class="visually-hidden">Actions</span>');
    expect(html).not.toContain("sr-only");
  });
});
