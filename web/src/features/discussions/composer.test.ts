import { describe, expect, it } from "vitest";
import { type ComposerKey, composerKey } from "@/features/discussions/composer";

function press(key: string, modifiers: Partial<ComposerKey> = {}): ComposerKey {
  return { key, shiftKey: false, ctrlKey: false, metaKey: false, ...modifiers };
}

describe("composerKey", () => {
  it("sends on Enter", () => {
    expect(composerKey(press("Enter"), false)).toBe("send");
  });

  it("inserts a newline on Shift+Enter", () => {
    expect(composerKey(press("Enter", { shiftKey: true }), false)).toBe(
      "newline",
    );
    expect(composerKey(press("Enter", { shiftKey: true }), true)).toBe(
      "newline",
    );
  });

  it("still sends on Ctrl+Enter and Cmd+Enter", () => {
    expect(composerKey(press("Enter", { ctrlKey: true }), false)).toBe("send");
    expect(composerKey(press("Enter", { metaKey: true }), false)).toBe("send");
  });

  it("accepts the suggestion on Enter or Tab while the mention menu is open", () => {
    expect(composerKey(press("Enter"), true)).toBe("accept");
    expect(composerKey(press("Tab"), true)).toBe("accept");
  });

  it("sends on Ctrl+Enter even while the mention menu is open", () => {
    expect(composerKey(press("Enter", { ctrlKey: true }), true)).toBe("send");
    expect(composerKey(press("Enter", { metaKey: true }), true)).toBe("send");
  });

  it("dismisses the mention menu on Escape", () => {
    expect(composerKey(press("Escape"), true)).toBe("dismiss");
  });

  it("moves through the suggestions with the arrow keys", () => {
    expect(composerKey(press("ArrowDown"), true)).toBe("down");
    expect(composerKey(press("ArrowUp"), true)).toBe("up");
  });

  it("leaves navigation keys alone when no menu is open", () => {
    for (const key of ["ArrowDown", "ArrowUp", "Escape", "Tab"]) {
      expect(composerKey(press(key), false)).toBeNull();
    }
  });

  it("leaves an Enter that commits an IME composition alone", () => {
    expect(
      composerKey(press("Enter", { isComposing: true }), false),
    ).toBeNull();
    expect(composerKey(press("Enter", { isComposing: true }), true)).toBeNull();
  });

  it("ignores ordinary typing", () => {
    expect(composerKey(press("a"), false)).toBeNull();
    expect(composerKey(press("a"), true)).toBeNull();
  });
});
