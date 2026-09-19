import { describe, expect, it } from "vitest";
import { formatTime, relativeTime } from "@/lib/format";

describe("time formatting", () => {
  it("renders English copy whatever the browser locale is", () => {
    expect(formatTime("2026-03-15T12:00:00Z")).toMatch(
      /^Mar 1[56], \d{2}:\d{2}\s[AP]M$/,
    );
    const earlier = new Date(Date.now() - 24 * 60_000).toISOString();
    expect(relativeTime(earlier)).toBe("24 minutes ago");
  });

  it("passes unparseable values through", () => {
    expect(formatTime("soon")).toBe("soon");
    expect(relativeTime("soon")).toBe("soon");
  });
});
