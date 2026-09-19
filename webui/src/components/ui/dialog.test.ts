import { describe, expect, it } from "vitest";
import { dialogFocusTarget } from "@/components/ui/dialog";

type Control = { id: string; disabled?: boolean };

const cancel: Control = { id: "cancel" };
const create: Control = { id: "create", disabled: true };
const remove: Control = { id: "delete" };
const topic: Control = { id: "topic" };
const other: Control = { id: "other" };
const off: Control = { id: "off", disabled: true };

describe("dialogFocusTarget", () => {
  it("prefers the first enabled field", () => {
    expect(dialogFocusTarget([topic, other], [cancel, create])).toBe(topic);
    expect(dialogFocusTarget([off, other], [])).toBe(other);
  });

  it("falls back to the last enabled footer button", () => {
    expect(dialogFocusTarget([], [cancel, remove])).toBe(remove);
    expect(dialogFocusTarget([], [cancel, create])).toBe(cancel);
  });

  it("gives nothing when nothing can take focus", () => {
    expect(dialogFocusTarget([], [])).toBeNull();
    expect(dialogFocusTarget([off], [create])).toBeNull();
  });
});
