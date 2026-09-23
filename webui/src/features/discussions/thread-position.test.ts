import { describe, expect, it } from "vitest";
import { centeredScrollTop } from "@/features/discussions/thread-position";

describe("New marker positioning", () => {
  it("centers the marker in the readable area after composer occlusion", () => {
    expect(centeredScrollTop(200, 1000, 500, 100, 784)).toBe(258);
  });

  it("clamps the target to the scrollable edges", () => {
    expect(centeredScrollTop(0, 1000, 10, 100, 784)).toBe(0);
    expect(centeredScrollTop(950, 1000, 900, 100, 784)).toBe(1000);
  });
});
