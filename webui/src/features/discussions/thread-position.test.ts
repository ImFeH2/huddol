import { describe, expect, it } from "vitest";
import {
  centeredScrollTop,
  shouldStopPositioningForKey,
} from "@/features/discussions/thread-position";

describe("New marker positioning", () => {
  it("centers the marker in the readable area after composer occlusion", () => {
    expect(centeredScrollTop(200, 1000, 500, 100, 784)).toBe(258);
  });

  it("clamps the target to the scrollable edges", () => {
    expect(centeredScrollTop(0, 1000, 10, 100, 784)).toBe(0);
    expect(centeredScrollTop(950, 1000, 900, 100, 784)).toBe(1000);
  });
});

describe("keyboard positioning cancellation", () => {
  const scrollTarget = { closest: () => null } as unknown as Element;

  it.each(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "])(
    "stops entry positioning for %s on the message area",
    (key) => {
      expect(shouldStopPositioningForKey(key, scrollTarget)).toBe(true);
    },
  );

  it.each(["Enter", "Escape", "a"])(
    "keeps entry positioning for non-scroll key %s",
    (key) => {
      expect(shouldStopPositioningForKey(key, scrollTarget)).toBe(false);
    },
  );

  it("preserves scrolling and control keys from interactive elements", () => {
    const input = { closest: () => ({}) } as unknown as Element;
    expect(shouldStopPositioningForKey("ArrowDown", input)).toBe(false);
    expect(shouldStopPositioningForKey(" ", input)).toBe(false);
  });
});
