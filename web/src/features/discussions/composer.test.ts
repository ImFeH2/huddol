import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  Composer,
  type ComposerKey,
  composerHeight,
  composerKey,
  composerMultiline,
} from "@/features/discussions/composer";

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

describe("composer layout", () => {
  it("uses measured wrapping rather than character count", () => {
    expect(composerMultiline("x".repeat(500), 46, 22, 24)).toBe(false);
    expect(composerMultiline("中文😀", 68, 22, 24)).toBe(true);
    expect(composerMultiline("", 68, 22, 24)).toBe(false);
    expect(composerMultiline("text", 47, 22, 24)).toBe(false);
  });

  it("expands explicit newlines and contracts when measured as one line", () => {
    expect(composerMultiline("\n", 46, 22, 24)).toBe(true);
    expect(composerMultiline("first\nsecond", 68, 22, 24)).toBe(true);
    expect(composerMultiline("first", 46, 22, 24)).toBe(false);
  });

  it("keeps reference silhouettes and grows with the capped input", () => {
    expect(composerHeight(false, 46)).toBe(48);
    expect(composerHeight(true, 68)).toBe(116);
    expect(composerHeight(true, 200)).toBe(242);
  });

  it("renders a real compact input, an inaccessible measuring probe and disabled send", () => {
    const html = renderToStaticMarkup(
      createElement(Composer, {
        members: [],
        memberIds: new Set<number>(),
        busy: false,
        placeholder: "Message",
        onSend: async () => true,
        onHeightChange: () => {},
      }),
    );
    expect(html).toContain('data-expanded="false"');
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-label="Message"');
    expect(html).toContain('aria-label="Send · Enter" disabled=""');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain("motion-reduce:transition-none");
    expect(html).not.toContain("Open prompt input");
    expect(html).not.toContain('type="file"');
  });
});
