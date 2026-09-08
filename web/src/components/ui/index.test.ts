import { describe, expect, it } from "vitest";
import { hueFor, initialsFor } from "./index";

describe("initialsFor", () => {
  it("uses the first two letters of a single word", () => {
    expect(initialsFor("Main")).toBe("MA");
  });

  it("uses first and last initials for multi word names", () => {
    expect(initialsFor("Technical Manager")).toBe("TM");
    expect(initialsFor("Product Advisor")).toBe("PA");
  });

  it("collapses extra whitespace", () => {
    expect(initialsFor("  Technical   Manager  ")).toBe("TM");
  });

  it("falls back for an empty name", () => {
    expect(initialsFor("   ")).toBe("?");
  });

  it("handles non latin names without crashing", () => {
    expect(initialsFor("产品顾问")).toBe("产品");
  });
});

describe("hueFor", () => {
  it("is stable for the same name", () => {
    expect(hueFor("Main")).toBe(hueFor("Main"));
  });

  it("returns a token reference", () => {
    expect(hueFor("Main")).toMatch(/^var\(--/);
  });

  it("spreads real member names across more than one hue", () => {
    const names = ["You", "Main", "Technical Manager", "Product Advisor"];
    expect(new Set(names.map(hueFor)).size).toBeGreaterThan(1);
  });
});
