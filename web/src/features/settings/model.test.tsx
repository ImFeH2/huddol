import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  ModelPanel,
  modelTestDescription,
  modelTestEnabled,
  modelUpdate,
} from "@/features/settings/model";

const values = {
  api_type: "openai",
  base_url: "https://example.invalid/v1",
  model: "local",
  api_key_set: true,
};

describe("Model settings", () => {
  it("sends only model settings and omits unchanged credentials", () => {
    expect(
      modelUpdate({ ...values, compaction_threshold: 320000 }, " "),
    ).toEqual({
      api_type: "openai",
      base_url: "https://example.invalid/v1",
      model: "local",
    });
  });

  it("includes only an explicitly entered key", () => {
    expect(
      modelUpdate({ ...values, api_key: "stored" }, " replacement "),
    ).toEqual({
      api_type: "openai",
      base_url: "https://example.invalid/v1",
      model: "local",
      api_key: "replacement",
    });
  });

  it.each(["openai", "openai-responses", "anthropic", "google"])(
    "enables Test for configured %s without requiring a typed key",
    (api_type) => {
      expect(
        modelTestEnabled({ ...values, api_type, api_key_set: false }, false),
      ).toBe(true);
      expect(modelUpdate({ ...values, api_type }, "").api_type).toBe(api_type);
    },
  );

  it.each([
    { api_type: "" },
    { api_type: "unsupported" },
    { base_url: "" },
    { base_url: "   " },
    { model: "" },
    { model: " \n " },
    { model: null },
  ])("disables Test for incomplete settings %o", (draft) => {
    expect(modelTestEnabled({ ...values, ...draft }, false)).toBe(false);
  });

  it("disables Test while a test is pending", () => {
    expect(modelTestEnabled(values, true)).toBe(false);
  });

  it("formats the reply as one line capped at 80 characters", () => {
    expect(modelTestDescription(1250, " \n Hello\r\n   world\t ")).toBe(
      "1,250 ms · Hello world",
    );
    expect(modelTestDescription(8, ` ${"a".repeat(100)} `)).toBe(
      `8 ms · ${"a".repeat(80)}`,
    );
  });

  it("renders provider segments, a model combobox and disabled actions before loading", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <ModelPanel />
      </TooltipProvider>,
    );
    for (const label of ["OpenAI", "OpenAI Responses", "Anthropic", "Google"]) {
      expect(html).toMatch(
        new RegExp(`<button[^>]*aria-pressed="false"[^>]*>${label}</button>`),
      );
    }
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-label="Choose model"');
    expect(html).toContain('type="password"');
    expect(html).toMatch(
      /<fieldset[^>]*aria-label="Model settings"[^>]*disabled=""/,
    );
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
    expect(html).toMatch(
      /<button[^>]*type="button"[^>]*disabled=""[^>]*>Test<\/button>/,
    );
    expect(html).not.toContain("Compaction");
    expect(html).not.toContain('type="number"');
    expect(html).not.toContain("Restart Huddol");
  });
});
