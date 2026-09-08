import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Banner } from "../ui/index";
import { Shell } from "./shell";

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
