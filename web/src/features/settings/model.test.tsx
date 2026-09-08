import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ModelPage, modelUpdate } from "./index";

const values = {
  api_type: "openai",
  base_url: "https://example.invalid/v1",
  model: "local",
  compaction_threshold: "320000",
  api_key_set: true,
};

describe("model compaction settings", () => {
  it("sends the threshold as an integer and omits unchanged credentials", () => {
    expect(modelUpdate(values, " ")).toEqual({
      api_type: "openai",
      base_url: "https://example.invalid/v1",
      model: "local",
      compaction_threshold: 320000,
    });
  });

  it("includes only an explicitly entered key", () => {
    expect(
      modelUpdate({ ...values, api_key: "stored" }, " replacement "),
    ).toEqual({
      api_type: "openai",
      base_url: "https://example.invalid/v1",
      model: "local",
      compaction_threshold: 320000,
      api_key: "replacement",
    });
  });

  it.each([
    "",
    "0",
    "-1",
    "1.5",
    "invalid",
    true,
    null,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects invalid threshold %s", (threshold) => {
    expect(
      modelUpdate({ ...values, compaction_threshold: threshold }, ""),
    ).toBeNull();
  });

  it("renders a labelled numeric field and disables saving before loading", () => {
    const html = renderToStaticMarkup(<ModelPage />);
    expect(html).toContain("Compaction threshold (bytes)");
    expect(html).toContain('type="number"');
    expect(html).toContain('min="1"');
    expect(html).toContain('step="1"');
    expect(html).toContain('type="submit"');
    expect(html).toContain('disabled=""');
  });
});
