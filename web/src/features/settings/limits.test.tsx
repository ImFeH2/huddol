import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LimitsPanel, limitsUpdate } from "@/features/settings/limits";

describe("token limit settings", () => {
  it("accepts any whole number including zero", () => {
    expect(limitsUpdate("0")).toEqual({ agent_token_limit: 0 });
    expect(limitsUpdate(" 250000 ")).toEqual({ agent_token_limit: 250000 });
  });

  it.each(["", "-1", "1.5", "1e3", "abc", "9007199254740992"])(
    "rejects %s",
    (limit) => {
      expect(limitsUpdate(limit)).toBeNull();
    },
  );

  it("renders an empty disabled field until the stored value arrives", () => {
    const html = renderToStaticMarkup(<LimitsPanel />);
    expect(html).toContain("Tokens per Agent");
    expect(html).toContain("0 means no ceiling.");
    expect(html).not.toContain("Enter a whole number.");
    expect(html).toContain(
      '<fieldset class="settings-form" aria-label="Limits settings" disabled="">',
    );
    expect(html).toMatch(/<input[^>]*type="number"[^>]*value=""/);
    expect(html).toMatch(/<input[^>]*inputMode="numeric"/);
    expect(html).not.toMatch(/value="0"/);
    expect(html).toContain('type="submit"');
    expect(html).not.toContain("banner");
    expect(html).not.toContain('role="status"');
  });
});
